import { shoulderTransform, warpGarment, pairTransform, warpLayers } from './warpGarment';
const reference = { leftShoulder: { x: .3, y: .3 }, rightShoulder: { x: .7, y: .3 } };
test.each([-25, 0, 25])('anchors stay attached at %s degrees with scale and translation', degrees => {
  const angle = degrees * Math.PI / 180, scale = 1.25;
  const current = Object.fromEntries(Object.entries(reference).map(([key, p]) => [key, {
    x: scale * (Math.cos(angle) * p.x - Math.sin(angle) * p.y) + .1,
    y: scale * (Math.sin(angle) * p.x + Math.cos(angle) * p.y) - .05,
  }]));
  const t = shoulderTransform(reference, current, 1000, 1000, 1000, 1000);
  for (const key of Object.keys(reference)) {
    const p = reference[key];
    expect(t.a * p.x * 1000 - t.b * p.y * 1000 + t.x).toBeCloseTo(current[key].x * 1000);
    expect(t.b * p.x * 1000 + t.a * p.y * 1000 + t.y).toBeCloseTo(current[key].y * 1000);
  }
});
test('invalid shoulders cannot alter the canvas', () => {
  const ctx = { canvas: { width: 100, height: 100 }, save: jest.fn() };
  expect(warpGarment(ctx, { width: 100, height: 100 }, {}, {})).toBe(false);
  expect(ctx.save).not.toHaveBeenCalled();
});
test('a leg segment follows its own hip→ankle anchors, independent of the shoulders', () => {
  const ref = { leftHip: { x: .4, y: .5 }, leftAnkle: { x: .4, y: .9 } };
  // Knee lifted forward: the ankle moves up and out, so the segment rotates 45° and shrinks.
  const cur = { leftHip: { x: .4, y: .5 }, leftAnkle: { x: .6, y: .7 } };
  const t = pairTransform(ref.leftHip, ref.leftAnkle, cur.leftHip, cur.leftAnkle, 1000, 1000, 1000, 1000);
  expect(t.rotation).toBeCloseTo(-Math.PI / 4);
  expect(t.scale).toBeCloseTo(Math.hypot(.2, .2) / .4);
  expect(t.a * .4 * 1000 - t.b * .9 * 1000 + t.x).toBeCloseTo(600);
  expect(t.b * .4 * 1000 + t.a * .9 * 1000 + t.y).toBeCloseTo(700);
});
test('warpLayers draws only the segments whose anchors are visible now', () => {
  const ctx = { canvas: { width: 100, height: 100 }, save: jest.fn(), restore: jest.fn(), transform: jest.fn(), drawImage: jest.fn() };
  const anchors = { leftShoulder: { x: .3, y: .3 }, rightShoulder: { x: .7, y: .3 }, leftHip: { x: .4, y: .6 }, leftKnee: { x: .4, y: .8 } };
  const canvas = { width: 100, height: 100 };
  const layers = [
    { name: 'leftThigh', pair: ['leftHip', 'leftKnee'], canvas, anchors },
    { name: 'torso', pair: ['leftShoulder', 'rightShoulder'], canvas, anchors },
  ];
  // Only the shoulders are tracked in this frame: the torso draws, the thigh is skipped.
  expect(warpLayers(ctx, layers, { leftShoulder: { x: .35, y: .3 }, rightShoulder: { x: .75, y: .3 } })).toBe(1);
  expect(ctx.drawImage).toHaveBeenCalledTimes(1);
});
