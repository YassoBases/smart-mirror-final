export function shoulderTransform(reference, current, sourceWidth, sourceHeight, width, height) {
  const points = [reference?.leftShoulder, reference?.rightShoulder, current?.leftShoulder, current?.rightShoulder];
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

export function warpGarment(ctx, garmentLayer, referenceAnchors, currentLandmarks) {
  const source = garmentLayer.canvas || garmentLayer;
  const transform = shoulderTransform(referenceAnchors, currentLandmarks,
    source.width, source.height, ctx.canvas.width, ctx.canvas.height);
  if (!transform) return false;
  ctx.save();
  ctx.transform(transform.a, transform.b, -transform.b, transform.a, transform.x, transform.y);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
  return true;
}
