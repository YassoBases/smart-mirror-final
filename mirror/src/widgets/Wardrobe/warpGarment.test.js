import { shoulderTransform, warpGarment } from './warpGarment';
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
