"""LOCAL-GPU demonstration fine-tune (NOT the spec's blip2-opt-2.7b).

The spec targets Salesforce/blip2-opt-2.7b, which does not fit a 6 GB GPU
(needs ~12-16 GB for QLoRA) — train that in the cloud via train.ipynb. This
script proves the fashion-attribute fine-tune pipeline runs on *this* GPU by
LoRA-fine-tuning the smaller Salesforce/blip-image-captioning-base on a subset of
the auto-downloadable `ashraq/fashion-product-images-small` dataset, and prints a
before/after caption comparison on held-out images.

  python train_on_gpu_demo.py --train 400 --eval 6 --epochs 1
"""
from __future__ import annotations

import argparse
import itertools

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from torch.utils.data import DataLoader
from transformers import BlipForConditionalGeneration, BlipProcessor

MODEL = "Salesforce/blip-image-captioning-base"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def caption_for(ex) -> str:
    parts = [ex.get("baseColour"), ex.get("articleType")]
    base = " ".join(p for p in parts if p)
    usage = ex.get("usage")
    return (f"{base}, {usage}".strip(", ").lower()) if base else "garment"


def collect(n):
    ds = load_dataset("ashraq/fashion-product-images-small", split="train", streaming=True)
    out = []
    for ex in itertools.islice(ds, n):
        out.append((ex["image"].convert("RGB"), caption_for(ex)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, default=400)
    ap.add_argument("--eval", type=int, default=6)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--out", default="./adapter_blip_base")
    args = ap.parse_args()

    if DEVICE != "cuda":
        raise SystemExit("No CUDA GPU — per the request, not training on CPU.")
    print(f"Device: {torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).total_memory/1e9:.1f} GB)")

    samples = collect(args.train + args.eval)
    train_samples, eval_samples = samples[: args.train], samples[args.train :]
    print(f"Loaded {len(train_samples)} train / {len(eval_samples)} eval samples")

    processor = BlipProcessor.from_pretrained(MODEL)
    # use_safetensors avoids the torch<2.6 .bin load gate (CVE-2025-32434).
    model = BlipForConditionalGeneration.from_pretrained(MODEL, use_safetensors=True).to(DEVICE)

    # Held-out captions BEFORE fine-tuning (base model).
    def caption(m, img):
        m.eval()
        with torch.no_grad():
            inp = processor(images=img, return_tensors="pt").to(DEVICE)
            out = m.generate(**inp, max_new_tokens=20)
        return processor.decode(out[0], skip_special_tokens=True)

    before = [caption(model, img) for img, _ in eval_samples]

    # LoRA on the attention query/value projections (text decoder + vision).
    lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
                      target_modules=["query", "value"])
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    def collate(batch):
        imgs, caps = zip(*batch)
        enc = processor(images=list(imgs), text=list(caps), padding=True, return_tensors="pt")
        enc["labels"] = enc["input_ids"].clone()
        return enc

    loader = DataLoader(train_samples, batch_size=args.batch, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=5e-4)
    scaler = torch.cuda.amp.GradScaler()

    model.train()
    step = 0
    for epoch in range(args.epochs):
        for batch in loader:
            batch = {k: v.to(DEVICE) for k, v in batch.items()}
            opt.zero_grad()
            with torch.cuda.amp.autocast(dtype=torch.float16):
                out = model(**batch)
                loss = out.loss
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            step += 1
            if step % 20 == 0:
                vram = torch.cuda.max_memory_allocated() / 1e9
                print(f"epoch {epoch} step {step}  loss {loss.item():.3f}  peakVRAM {vram:.2f} GB")

    after = [caption(model, img) for img, _ in eval_samples]

    print("\n=== before vs after (held-out) ===")
    for (img, gold), b, a in zip(eval_samples, before, after):
        print(f"  gold : {gold}")
        print(f"  base : {b}")
        print(f"  tuned: {a}\n")

    model.save_pretrained(args.out)
    print(f"Saved LoRA adapter -> {args.out}")
    print(f"Peak VRAM: {torch.cuda.max_memory_allocated()/1e9:.2f} GB on {torch.cuda.get_device_name(0)}")


if __name__ == "__main__":
    main()
