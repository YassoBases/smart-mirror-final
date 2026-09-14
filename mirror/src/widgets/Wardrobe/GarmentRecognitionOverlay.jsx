// Ambient "do I already own this?" feedback. Reuses the FeedbackHint button
// style (Yes/No pinch-clickable pair) and the existing open-palm/fist dwell
// gestures — open palm = confirm, fist = decline — the same hands-free
// semantics the wardrobe already uses for invoke/dismiss, applied here instead
// of inventing a new gesture. No image is ever shown, sent, or captured before
// this prompt appears, and none of it is stored unless the user picks "Yes".
import { useEffect } from 'react';
import { createGestureRecognizer } from './gestureMap';

export default function GarmentRecognitionOverlay({ phase, result, onConfirm }) {
  useEffect(() => {
    if (phase !== 'confirming') return;
    return createGestureRecognizer({
      onInvoke: () => onConfirm(true),
      onDismiss: () => onConfirm(false),
    });
  }, [phase, onConfirm]);

  if (phase === 'idle' || phase === 'checking') return null;

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 rounded-lg bg-black/85 p-3 text-white">
      {phase === 'confirming' && (
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm">I don't recognize this — add it to your wardrobe?</span>
          <span className="text-[11px] text-white/50">Open palm = yes &middot; fist = no</span>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => onConfirm(true)}
              aria-label="Add to my wardrobe"
              className="rounded-lg border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-400/20"
            >
              Add it
            </button>
            <button
              type="button"
              onClick={() => onConfirm(false)}
              aria-label="Don't add to my wardrobe"
              className="rounded-lg border border-rose-300/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-200 hover:bg-rose-400/20"
            >
              No thanks
            </button>
          </div>
        </div>
      )}

      {phase === 'recognized' && result?.item && (
        <div className="flex items-center gap-3">
          {result.item.thumbnailUrl && (
            <img src={result.item.thumbnailUrl} alt="" className="h-10 w-10 rounded object-cover" />
          )}
          <span className="text-sm">
            That's your {result.item.subcategory || result.item.category}
            {result.item.primaryColor ? ` (${result.item.primaryColor})` : ''} — already in your closet.
          </span>
        </div>
      )}

      {phase === 'enrolling' && (
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <span className="text-sm">Adding to your wardrobe…</span>
        </div>
      )}

      {phase === 'added' && result?.item && (
        <div className="flex items-center gap-3">
          {result.item.thumbnailUrl && (
            <img src={result.item.thumbnailUrl} alt="Newly added garment" className="h-12 w-12 rounded object-cover" />
          )}
          <div className="flex flex-col">
            <span className="text-sm text-emerald-200">Added to your wardrobe</span>
            <span className="text-[11px] text-white/60">
              {[result.item.primaryColor, result.item.subcategory || result.item.category].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
