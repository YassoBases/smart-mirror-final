# Demo wardrobe assets

[manifest.json](manifest.json) lists 32 garments (tops, bottoms, outerwear,
footwear, accessories) with realistic attributes. `seed_demo_wardrobe.js` reads
it to populate the demo closet.

## Images

Drop **CC-licensed** JPGs into `images/`, named to match each manifest `file`
(e.g. `images/navy-henley.jpg`). Good sources: Unsplash, Pexels, or Wikimedia
Commons (check each license; attribute as required).

Any missing image is **synthesized as a solid color swatch** from the item's
`primaryColor`, so `node tools/seed_demo_wardrobe.js` works out-of-the-box for a
dry run — replace the swatches with real photos before the live demo so the
flat-lay board and VTON look convincing.
