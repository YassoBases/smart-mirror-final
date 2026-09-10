# Delivered wardrobe classifier

See [the service guide](../../services/wardrobe_attr/README.md) for the frozen-CLIP
ensemble, deployment, compatibility settings and historical training limitations.
The classifier returns the existing wardrobe item attributes. Pixel-derived colors
and rule-derived warmth/seasons complement the learned heads. Optional backend
OpenAI image verification is a separate stage with external image transfer.
