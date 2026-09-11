import { segmentQuad, torsoQuad, torsoBounds } from './garmentLayer';
jest.mock('./wardrobeApi', () => ({ wardrobeApi: { extractLayer: jest.fn() } }));

test('a limb quad is centred on its segment, wider than the bone and overruns both joints', () => {
  const quad = segmentQuad({ x: .5, y: .5 }, { x: .5, y: .9 }, .05);
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  expect(Math.min(...xs)).toBeCloseTo(.45); expect(Math.max(...xs)).toBeCloseTo(.55);
  expect(Math.min(...ys)).toBeLessThan(.5); expect(Math.max(...ys)).toBeGreaterThan(.9);
});
test('the torso quad covers shoulders to hips with sleeve margin and a hem overlap', () => {
  const anchors = { leftShoulder: { x: .3, y: .3 }, rightShoulder: { x: .7, y: .3 }, leftHip: { x: .35, y: .6 }, rightHip: { x: .65, y: .6 } };
  const quad = torsoQuad(anchors);
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  expect(Math.min(...xs)).toBeLessThan(.3); expect(Math.max(...xs)).toBeGreaterThan(.7);
  expect(Math.min(...ys)).toBeLessThan(.3); expect(Math.max(...ys)).toBeGreaterThan(.6);
  const bounds = torsoBounds(anchors);
  expect(Math.max(...ys)).toBeGreaterThan(bounds.bottom);
});
