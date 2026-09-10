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

// rembg separates foreground from background, not clothing from skin. Restrict
// both paths to the reference torso; this is a deliberately degraded torso layer.
export async function extractGarmentLayer(renderImageUrl, poseAtRender) {
  const anchors = JSON.parse(JSON.stringify(poseAtRender.landmarks || poseAtRender));
  const bounds = torsoBounds(anchors);
  const response = await fetch(renderImageUrl);
  if (!response.ok) throw new Error(`Cannot load try-on image (${response.status}).`);
  const original = await response.blob();
  let source = original;
  let extraction = 'background-removed-torso';
  try { source = await wardrobeApi.extractLayer(original); }
  catch { extraction = 'rectangular-torso'; }
  const image = await decode(source);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.rect(bounds.left * canvas.width, bounds.top * canvas.height,
    (bounds.right - bounds.left) * canvas.width, (bounds.bottom - bounds.top) * canvas.height);
  ctx.clip(); ctx.drawImage(image, 0, 0);
  return { canvas, anchors, extraction };
}
