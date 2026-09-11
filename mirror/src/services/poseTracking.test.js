import { Pose } from '@mediapipe/pose';
import { startPoseTracking, stopPoseTracking, garmentLandmarks } from './poseTracking';
import { publishCameraVideo, getCameraVideo, releaseCameraVideo } from './cameraStream';
jest.mock('@mediapipe/pose', () => ({ Pose: jest.fn() }));

let model, onResults;
beforeEach(() => {
  jest.useFakeTimers();
  model = { initialize: jest.fn(async () => {}), setOptions: jest.fn(), close: jest.fn(async () => {}),
    onResults: jest.fn(cb => { onResults = cb; }), send: jest.fn(async () => { onResults({}); }) };
  Pose.mockImplementation(() => model);
  window.__LIVE_TRYON_DISABLE_POSE__ = false;
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
test('shares the existing video, throttles sends and never stops its tracks', async () => {
  const stop = jest.fn();
  const video = { srcObject: { getTracks: () => [{stop}] }, readyState: 2, videoWidth: 320 };
  publishCameraVideo(video);
  const result = jest.fn();
  const handle = startPoseTracking(null, result);
  await handle.ready;
  await jest.advanceTimersByTimeAsync?.(1); // Jest 27 does not expose async timer helpers.
  jest.advanceTimersByTime(1);
  await Promise.resolve(); await Promise.resolve();
  expect(model.send).toHaveBeenCalledTimes(1);
  expect(model.send).toHaveBeenCalledWith({image:video});
  expect(result).toHaveBeenCalledWith(expect.objectContaining({visible:false,landmarks:{}}));
  stopPoseTracking(handle);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  jest.advanceTimersByTime(1000);
  expect(model.send).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
  releaseCameraVideo(video);
  expect(getCameraVideo()).toBeNull();
});
test('initialization failure logs once and reports a usable fallback', async () => {
  jest.spyOn(console,'warn').mockImplementation(() => {});
  const result=jest.fn();
  const handle=startPoseTracking(null,result,{disabled:true});
  expect(await handle.ready).toBe(false);
  expect(result).toHaveBeenCalledWith(expect.objectContaining({visible:false,error:expect.stringContaining('still image')}));
  expect(console.warn).toHaveBeenCalledTimes(1);
  stopPoseTracking(handle);
});
test('exposes only normalized garment points and rejects hidden torso anchors', () => {
  const all=Array.from({length:33},()=>({x:2,y:-1,visibility:1}));
  let result=garmentLandmarks(all);
  // Torso + arms (8) plus knees, ankles and foot tips (6) for the Live+ leg/shoe layers.
  expect(Object.keys(result.landmarks)).toHaveLength(14);
  expect(result.landmarks.leftShoulder).toEqual({x:1,y:0,visibility:1});
  expect(result.landmarks.leftAnkle).toEqual({x:1,y:0,visibility:1});
  expect(result.visible).toBe(true);
  all[23].visibility=0;
  expect(garmentLandmarks(all).visible).toBe(false);
});
