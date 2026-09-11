import { wardrobeApi } from './wardrobeApi';

const torsoNames = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];
export function torsoBounds(anchors) {
  const points = torsoNames.map(name => anchors?.[name]);
  if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    throw new Error('A visible reference torso is required.');
  }
  return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
    top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
}

async function decode(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Cannot decode try-on image.'));
      image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

async function loadPersonCutout(renderImageUrl) {
  const response = await fetch(renderImageUrl);
  if (!response.ok) throw new Error(`Cannot load try-on image (${response.status}).`);
  const original = await response.blob();
  let source = original;
  let extraction = 'background-removed';
  try { source = await wardrobeApi.extractLayer(original); }
  catch { extraction = 'rectangular'; }
  return { image: await decode(source), extraction };
}

// rembg separates foreground from background, not clothing from skin. Restrict
// both paths to the reference torso; this is a deliberately degraded torso layer.
export async function extractGarmentLayer(renderImageUrl, poseAtRender) {
  const anchors = JSON.parse(JSON.stringify(poseAtRender.landmarks || poseAtRender));
  const bounds = torsoBounds(anchors);
  const { image, extraction } = await loadPersonCutout(renderImageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.rect(bounds.left * canvas.width, bounds.top * canvas.height,
    (bounds.right - bounds.left) * canvas.width, (bounds.bottom - bounds.top) * canvas.height);
  ctx.clip(); ctx.drawImage(image, 0, 0);
  return { canvas, anchors, extraction: `${extraction}-torso` };
}

// ── Multi-segment layers (hosted "Live+" mode) ─────────────────────────────────
// The hosted keyframe already shows the whole outfit on the person, so the layer
// set covers the full body: one quad per limb segment, each warped independently
// by its own two anchor landmarks (see warpLayers). Draw order is legs → feet →
// torso so the top overlaps the waistband rather than the reverse.
const SEGMENTS = [
  { name: 'leftThigh', pair: ['leftHip', 'leftKnee'] },
  { name: 'rightThigh', pair: ['rightHip', 'rightKnee'] },
  { name: 'leftShin', pair: ['leftKnee', 'leftAnkle'] },
  { name: 'rightShin', pair: ['rightKnee', 'rightAnkle'] },
  { name: 'leftFoot', pair: ['leftAnkle', 'leftFootIndex'], widthScale: 1.6 },
  { name: 'rightFoot', pair: ['rightAnkle', 'rightFootIndex'], widthScale: 1.6 },
  { name: 'torso', pair: ['leftShoulder', 'rightShoulder'], torso: true },
];

const visible = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 1) >= 0.5;

// A quad around the segment a→b: `halfWidth` (normalized) to each side, extended
// a little past both ends so joints overlap instead of leaving seams.
export function segmentQuad(a, b, halfWidth, overrun = 0.15) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const ax = a.x - ux * len * overrun, ay = a.y - uy * len * overrun;
  const bx = b.x + ux * len * overrun, by = b.y + uy * len * overrun;
  return [
    { x: ax + nx * halfWidth, y: ay + ny * halfWidth }, { x: bx + nx * halfWidth, y: by + ny * halfWidth },
    { x: bx - nx * halfWidth, y: by - ny * halfWidth }, { x: ax - nx * halfWidth, y: ay - ny * halfWidth },
  ];
}

// Torso polygon: shoulders (with sleeve margin) down to hips, extended below the
// hips so the hem overlaps the thighs.
export function torsoQuad(anchors) {
  const { leftShoulder: ls, rightShoulder: rs, leftHip: lh, rightHip: rh } = anchors;
  const shoulderWidth = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const margin = shoulderWidth * 0.35, hem = shoulderWidth * 0.25, neck = shoulderWidth * 0.12;
  const sign = rs.x >= ls.x ? 1 : -1;
  return [
    { x: ls.x - sign * margin, y: ls.y - neck }, { x: rs.x + sign * margin, y: rs.y - neck },
    { x: rh.x + sign * margin * 0.6, y: rh.y + hem }, { x: lh.x - sign * margin * 0.6, y: lh.y + hem },
  ];
}

function clipTo(ctx, quad, width, height) {
  ctx.beginPath();
  quad.forEach((p, i) => (i ? ctx.lineTo(p.x * width, p.y * height) : ctx.moveTo(p.x * width, p.y * height)));
  ctx.closePath(); ctx.clip();
}

// Builds the per-segment layers for a hosted keyframe. Segments whose anchors are
// not visible in the keyframe pose are skipped, so a waist-up frame still yields
// a torso layer. Throws when even the torso is missing.
export async function extractOutfitLayers(renderImageUrl, poseAtRender) {
  const anchors = JSON.parse(JSON.stringify(poseAtRender.landmarks || poseAtRender));
  torsoBounds(anchors);
  const { image, extraction } = await loadPersonCutout(renderImageUrl);
  const width = image.naturalWidth, height = image.naturalHeight;
  const hipHalfWidth = Math.hypot(anchors.rightHip.x - anchors.leftHip.x, anchors.rightHip.y - anchors.leftHip.y) * 0.45;
  const layers = [];
  for (const segment of SEGMENTS) {
    const [a, b] = segment.pair;
    if (!visible(anchors[a]) || !visible(anchors[b])) continue;
    const quad = segment.torso ? torsoQuad(anchors)
      : segmentQuad(anchors[a], anchors[b], hipHalfWidth * (segment.widthScale || 1));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    clipTo(ctx, quad, width, height);
    ctx.drawImage(image, 0, 0);
    layers.push({ name: segment.name, pair: segment.pair, canvas, anchors });
  }
  return { layers, anchors, extraction: `${extraction}-segments` };
}
