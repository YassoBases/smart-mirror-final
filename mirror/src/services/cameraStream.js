// The hand/face service remains the sole owner of the camera and its tracks.
let cameraVideo = null;
export function publishCameraVideo(video) { cameraVideo = video; }
export function releaseCameraVideo(video) { if (cameraVideo === video) cameraVideo = null; }
export function getCameraVideo() {
  return cameraVideo?.srcObject && cameraVideo.readyState >= 2 ? cameraVideo : null;
}
