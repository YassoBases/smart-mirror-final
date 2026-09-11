// Similarity transform (translation, rotation, uniform scale) that maps the
// reference segment (refA→refB, normalized to the source image) onto the current
// segment (curA→curB, normalized to the destination canvas).
export function pairTransform(refA, refB, curA, curB, sourceWidth, sourceHeight, width, height) {
  const points = [refA, refB, curA, curB];
  if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const [l, r, cl, cr] = points;
  const sx = (r.x - l.x) * sourceWidth, sy = (r.y - l.y) * sourceHeight;
  const dx = (cr.x - cl.x) * width, dy = (cr.y - cl.y) * height;
  const squared = sx * sx + sy * sy;
  if (squared < 1 || Math.hypot(dx, dy) < 1) return null;
  const a = (dx * sx + dy * sy) / squared;
  const b = (dy * sx - dx * sy) / squared;
  return { a, b, x: cl.x * width - a * l.x * sourceWidth + b * l.y * sourceHeight,
    y: cl.y * height - b * l.x * sourceWidth - a * l.y * sourceHeight,
    scale: Math.hypot(a, b), rotation: Math.atan2(b, a) };
}

export function shoulderTransform(reference, current, sourceWidth, sourceHeight, width, height) {
  return pairTransform(reference?.leftShoulder, reference?.rightShoulder,
    current?.leftShoulder, current?.rightShoulder, sourceWidth, sourceHeight, width, height);
}

function drawTransformed(ctx, source, transform) {
  ctx.save();
  ctx.transform(transform.a, transform.b, -transform.b, transform.a, transform.x, transform.y);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

export function warpGarment(ctx, garmentLayer, referenceAnchors, currentLandmarks) {
  const source = garmentLayer.canvas || garmentLayer;
  const transform = shoulderTransform(referenceAnchors, currentLandmarks,
    source.width, source.height, ctx.canvas.width, ctx.canvas.height);
  if (!transform) return false;
  drawTransformed(ctx, source, transform);
  return true;
}

// Draws every segment layer whose two anchor landmarks are visible now. Layers
// are drawn in array order (legs before feet before torso, see garmentLayer.js).
// Returns the number of segments drawn so callers can tell "nothing visible"
// from "partially tracked".
export function warpLayers(ctx, layers, currentLandmarks) {
  let drawn = 0;
  for (const layer of layers || []) {
    const [a, b] = layer.pair;
    const transform = pairTransform(layer.anchors?.[a], layer.anchors?.[b], currentLandmarks?.[a], currentLandmarks?.[b],
      layer.canvas.width, layer.canvas.height, ctx.canvas.width, ctx.canvas.height);
    if (!transform) continue;
    drawTransformed(ctx, layer.canvas, transform);
    drawn++;
  }
  return drawn;
}
