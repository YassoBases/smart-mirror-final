import { Pose } from '@mediapipe/pose';
import { getCameraVideo } from './cameraStream';

export const GARMENT_POINTS = {
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24,
};
export function garmentLandmarks(all) {
  const landmarks = {};
  for (const [name, index] of Object.entries(GARMENT_POINTS)) {
    const p = all?.[index];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      landmarks[name] = { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)), visibility: p.visibility ?? 0 };
    }
  }
  const visible = ['leftShoulder','rightShoulder','leftHip','rightHip'].every(k => landmarks[k]?.visibility >= 0.5);
  return { landmarks, visible };
}

export function startPoseTracking(videoEl, onResult, opts = {}) {
  const handle = { stopped: false, timer: null, pose: null, inFlight: null, warned: false, video: videoEl || getCameraVideo() };
  const fail = message => {
    if (handle.stopped) return;
    if (!handle.warned) { console.warn('[Live try-on]', message); handle.warned = true; }
    onResult({ landmarks: {}, timestamp: performance.now(), visible: false, error: message });
  };
  const fps = Math.max(1, Math.min(30, Number(opts.targetFps) || 15));
  const tick = async () => {
    if (handle.stopped) return;
    const started = performance.now();
    try {
      if (handle.video.readyState < 2 || !handle.video.videoWidth || !handle.video.srcObject) {
        fail('Camera is unavailable. Showing the still image.');
        return;
      }
      handle.inFlight = handle.pose.send({ image: handle.video });
      await handle.inFlight;
    } catch (e) { fail('Pose tracking is unavailable. Showing the still image.'); return; }
    finally { handle.inFlight = null; }
    if (!handle.stopped) handle.timer = setTimeout(tick, Math.max(0, 1000 / fps - (performance.now() - started)));
  };
  handle.ready = (async () => {
    try {
      if (opts.disabled || window.__LIVE_TRYON_DISABLE_POSE__ || !handle.video?.srcObject) {
        fail('Pose tracking is unavailable. Showing the still image.'); return false;
      }
      handle.pose = new Pose({ locateFile: name => `${process.env.PUBLIC_URL || ''}/mediapipe/pose/${name}` });
      handle.pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false,
        minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      handle.pose.onResults(result => {
        if (!handle.stopped) onResult({ ...garmentLandmarks(result.poseLandmarks), timestamp: performance.now() });
      });
      await handle.pose.initialize();
      if (!handle.stopped) handle.timer = setTimeout(tick, 0);
      return !handle.stopped;
    } catch (e) { fail('Pose tracking could not start. Showing the still image.'); return false; }
  })();
  return handle;
}

export function stopPoseTracking(handle) {
  if (!handle || handle.stopped) return;
  handle.stopped = true;
  clearTimeout(handle.timer);
  // Never stop or replace shared camera tracks. Wait for initialization/inference
  // before closing the model so an outstanding WASM call cannot use freed state.
  Promise.resolve(handle.ready).then(() => handle.inFlight).catch(() => {}).finally(() => handle.pose?.close()).catch(() => {});
}

// The slow path uses a saved body photo. Its landmarks must be measured on that
// image, rather than assuming the live camera was in the same pose.
export async function estimateImagePose(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    image.onload = resolve; image.onerror = () => reject(new Error('Cannot read keyframe pose.')); image.src = url;
  });
  const pose = new Pose({ locateFile: name => `${process.env.PUBLIC_URL || ''}/mediapipe/pose/${name}` });
  try {
    pose.setOptions({ modelComplexity: 0, smoothLandmarks: false, enableSegmentation: false });
    let result;
    pose.onResults(value => { result = garmentLandmarks(value.poseLandmarks); });
    await pose.initialize(); await pose.send({ image });
    if (!result?.visible) throw new Error('The saved image has no visible torso. Showing the still image.');
    return result;
  } finally { await pose.close(); }
}

