import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import Wardrobe from './index';
import VtonView from './VtonView';
import { wardrobeApi } from './wardrobeApi';
import { publishCameraVideo } from '../../services/cameraStream';
import { startPoseTracking, estimateImagePose } from '../../services/poseTracking';
import { extractGarmentLayer } from './garmentLayer';
import { createGestureRecognizer } from './gestureMap';
let mockProfileId = 1;
jest.mock('../../contexts/ProfileContext', () => ({ useProfile: () => ({ activeProfile: { profileId: mockProfileId } }) }));
jest.mock('./wardrobeApi', () => ({ wardrobeApi: { listItems: jest.fn(), suggest: jest.fn(), render: jest.fn(), renderLive: jest.fn() } }));
jest.mock('../../services/poseTracking', () => ({ startPoseTracking: jest.fn(), stopPoseTracking: jest.fn(), estimateImagePose: jest.fn() }));
jest.mock('./garmentLayer', () => ({ extractGarmentLayer: jest.fn(), extractOutfitLayers: jest.fn() }));
import { extractOutfitLayers } from './garmentLayer';
beforeEach(() => {
  wardrobeApi.listItems.mockResolvedValue({ items: [{ id: 1, category: 'top', subcategory: 'shirt', thumbnailUrl: '/shirt.jpg' }] });
  wardrobeApi.suggest.mockResolvedValue({ candidates: [{ itemIds: [1], reasoning: 'A blue shirt', confidence: .9 }] });
  wardrobeApi.render.mockResolvedValue({ renderUrl: '/render.jpg', fromCache: true });
});
afterEach(() => { cleanup(); jest.clearAllMocks(); jest.useRealTimers(); delete window.__LIVE_TRYON_DISABLE_POSE__; publishCameraVideo(null); });
test('browse → select → real session request → displayed still result', async () => {
  render(<Wardrobe />); fireEvent.click(screen.getByText('From my closet'));
  expect(await screen.findByText('shirt')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Try it on me'));
  expect(await screen.findByAltText('Virtual try-on')).toHaveAttribute('src', '/render.jpg');
  expect(wardrobeApi.render).toHaveBeenCalledWith([1]);
});
test.each([['empty', 'No outfits to suggest yet'], ['error', 'Backend unreachable']])('wardrobe %s is visible', async (mode, expected) => {
  if (mode === 'empty') wardrobeApi.suggest.mockResolvedValue({ candidates: [] });
  else wardrobeApi.suggest.mockRejectedValue(new Error(expected));
  render(<Wardrobe />); fireEvent.click(screen.getByText('From my closet'));
  expect(await screen.findByText(new RegExp(expected))).toBeInTheDocument();
  expect(wardrobeApi.suggest).toHaveBeenCalled();
});
test('forcibly disabled pose keeps still image and explains fallback', async () => {
  window.__LIVE_TRYON_DISABLE_POSE__ = true;
  render(<VtonView renderUrl="/still.jpg" />); fireEvent.click(screen.getByText('Live off'));
  expect(await screen.findByRole('status')).toHaveTextContent('Showing the still image');
  expect(screen.getByAltText('Virtual try-on')).toHaveAttribute('src', '/still.jpg');
  fireEvent.click(screen.getByText('Live on'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
test('available pose enables camera canvas and off restores identical still', async () => {
  publishCameraVideo({ srcObject: {}, readyState: 2, videoWidth: 640, videoHeight: 480, currentTime: 0 });
  estimateImagePose.mockResolvedValue({ landmarks: {}, visible: true });
  extractGarmentLayer.mockResolvedValue({ canvas: document.createElement('canvas'), anchors: {} });
  startPoseTracking.mockReturnValue({ ready: Promise.resolve(true) });
  const raf = jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  render(<VtonView renderUrl="/still.jpg" />); fireEvent.click(screen.getByText('Live off'));
  await waitFor(() => expect(screen.queryByAltText('Virtual try-on')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Live try-on camera')).not.toHaveClass('hidden');
  fireEvent.click(screen.getByText('Live on'));
  expect(screen.getByAltText('Virtual try-on')).toHaveAttribute('src', '/still.jpg'); raf.mockRestore();
});
// Live+ (hosted) mode: the keyframe is a hosted render of a frame captured from
// the camera, split into per-limb layers. These stub the canvas capture jsdom
// lacks and drive the pose callback so the first keyframe request fires.
function stubLiveCapture() {
  publishCameraVideo({ srcObject: {}, readyState: 2, videoWidth: 640, videoHeight: 480, currentTime: 0 });
  const pose = { leftShoulder: { x: .3, y: .3 }, rightShoulder: { x: .7, y: .3 }, leftHip: { x: .35, y: .6 }, rightHip: { x: .65, y: .6 } };
  startPoseTracking.mockImplementation((video, onResult) => {
    onResult({ landmarks: pose, visible: true, timestamp: performance.now() });
    return { ready: Promise.resolve(true) };
  });
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: jest.fn() });
  jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) { cb(new Blob(['frame'], { type: 'image/jpeg' })); });
  jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
}
test('Live+ renders a captured camera frame through the hosted keyframe and shows the live canvas', async () => {
  stubLiveCapture();
  estimateImagePose.mockResolvedValue({ landmarks: {}, visible: true });
  extractOutfitLayers.mockResolvedValue({ layers: [{ name: 'torso', pair: ['leftShoulder', 'rightShoulder'], canvas: document.createElement('canvas'), anchors: {} }], anchors: {}, extraction: 'test' });
  const requestKeyframe = jest.fn(async () => ({ renderUrl: '/live.jpg', fromCache: false, hostedRenderCount: 1, imagesSent: 4 }));
  render(<VtonView renderUrl="/still.jpg" requestKeyframe={requestKeyframe} imagesPerRequest={4} />);
  fireEvent.click(screen.getByText('Live+ off'));
  await waitFor(() => expect(screen.getByLabelText('Live try-on camera')).not.toHaveClass('hidden'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  const [captured] = requestKeyframe.mock.calls[0];
  expect(captured.frame).toBeInstanceOf(Blob);
  expect(captured.landmarks.leftShoulder).toBeDefined();
  expect(extractOutfitLayers).toHaveBeenCalledWith('/live.jpg', expect.anything());
  expect(screen.getByText('Live+ on')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Live off')).toHaveAttribute('aria-pressed', 'false');
  jest.restoreAllMocks();
});
test('Live+ falls back to the still image and says why when the hosted render is not configured', async () => {
  stubLiveCapture();
  const requestKeyframe = jest.fn(async () => { throw new Error('Hosted live try-on is not configured (no Replicate token)'); });
  render(<VtonView renderUrl="/still.jpg" requestKeyframe={requestKeyframe} />);
  fireEvent.click(screen.getByText('Live+ off'));
  expect(await screen.findByRole('status')).toHaveTextContent('Hosted live try-on is not configured');
  expect(screen.getByAltText('Virtual try-on')).toHaveAttribute('src', '/still.jpg');
  expect(extractOutfitLayers).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});
test('gesture stream dispatches documented dwell and swipe actions, then unsubscribes', () => {
  jest.useFakeTimers(); jest.setSystemTime(10000);
  const handlers = { onInvoke: jest.fn(), onDismiss: jest.fn(), onNext: jest.fn() };
  const stop = createGestureRecognizer(handlers);
  const send = detail => window.dispatchEvent(new CustomEvent('smartMirror:hand', { detail }));
  send({ detected: true, isHandOpen: true }); jest.advanceTimersByTime(901); send({ detected: true, isHandOpen: true });
  expect(handlers.onInvoke).toHaveBeenCalledWith('wardrobe_invoke');
  jest.advanceTimersByTime(1201); send({ detected: false }); send({ detected: true, isFist: true });
  jest.advanceTimersByTime(701); send({ detected: true, isFist: true }); expect(handlers.onDismiss).toHaveBeenCalledWith('dismiss');
  jest.advanceTimersByTime(1201); send({ detected: false }); send({ detected: true, x: 0 }); send({ detected: true, x: window.innerWidth * .3 });
  expect(handlers.onNext).toHaveBeenCalledWith('next_outfit'); stop();
  send({ detected: true, x: window.innerWidth }); expect(handlers.onNext).toHaveBeenCalledTimes(1);
});

test('profile switch invalidates an outstanding wardrobe result', async () => {
  let resolve;
  wardrobeApi.suggest.mockReturnValue(new Promise(done => { resolve = done; }));
  const { rerender } = render(<Wardrobe />);
  fireEvent.click(screen.getByText('From my closet'));
  mockProfileId = 2; rerender(<Wardrobe />);
  await act(async () => resolve({ candidates: [{ itemIds: [1], reasoning: 'OLD PROFILE', confidence: .8 }] }));
  expect(screen.queryByText('OLD PROFILE')).not.toBeInTheDocument();
  expect(screen.getByText('From my closet')).toBeInTheDocument();
  mockProfileId = 1;
});
