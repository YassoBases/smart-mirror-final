import { useEffect, useRef, useState } from 'react';
import { getCameraVideo } from '../../services/cameraStream';
import { startPoseTracking, stopPoseTracking, estimateImagePose } from '../../services/poseTracking';
import { extractGarmentLayer } from './garmentLayer';
import { shoulderTransform, warpGarment } from './warpGarment';

export function poseDiverged(reference, current, width, height) {
  const t = shoulderTransform(reference, current, width, height, width, height);
  return !!t && (Math.abs(t.rotation) > Math.PI / 6 || Math.abs(t.scale - 1) > .30);
}

export function useLiveTryOn({ enabled, canvasRef, renderUrl, selectionKey, requestKeyframe,
  refreshIntervalMs = 8000, imagesPerRequest = 1 }) {
  const [notice, setNotice] = useState('');
  const [active, setActive] = useState(false);
  const requestRef = useRef(requestKeyframe); requestRef.current = requestKeyframe;
  useEffect(() => {
    setActive(false); setNotice('');
    if (!enabled || !renderUrl) return;
    const video = getCameraVideo();
    if (!video || window.__LIVE_TRYON_DISABLE_POSE__) {
      setNotice('Live pose tracking is unavailable. Showing the still image.'); return;
    }
    let stopped = false, handle, raf, layer, latest, referenceLive, pending = false;
    let lastRefresh = performance.now(), retryAt = 0, failures = 0, lastVideoTime = -1;
    let frameWindow = performance.now(), windowFrames = 0, warmedAt = null;
    const requests = [], submitted = [];
    const cost = Math.max(1, imagesPerRequest);
    const interval = Math.max(8000, refreshIntervalMs, Math.ceil(cost * 60000 / 9));
    const stats = { warpFps: 0, keyframeCount: 0, imagesSentPerMinute: 0, poseDropouts: 0,
      keyframesRequested: 0, keyframesFromCache: 0, warpedFrames: 0, effectiveRefreshIntervalMs: interval,
      telemetryComplete: true, status: 'starting' };
    const publish = () => { window.__LIVE_TRYON_STATS__ = { ...stats }; console.info('[Live try-on]', window.__LIVE_TRYON_STATS__); };
    const fallback = message => {
      if (stopped) return;
      stats.status = 'still'; publish(); setNotice(message); setActive(false);
      stopped = true; stopPoseTracking(handle); cancelAnimationFrame(raf);
    };
    const load = async url => {
      const pose = await estimateImagePose(url);
      const next = await extractGarmentLayer(url, pose);
      if (!stopped) { layer = next; referenceLive = latest?.landmarks; }
    };
    const refresh = async now => {
      if (!requestRef.current || pending || now < retryAt) return;
      // Reserve a conservative image budget even on failure (the renderer may
      // have received images before its response was lost).
      while (requests.length && now - requests[0].time >= 60000) requests.shift();
      if (requests.reduce((sum, r) => sum + r.cost, 0) + cost > 9) return;
      pending = true; requests.push({ time: now, cost }); stats.keyframesRequested++;
      try {
        const result = await requestRef.current();
        if (stopped) return;
        if (result.fromCache) { stats.keyframesFromCache++; requests[requests.length - 1].cost = 0; }
        if (Number.isFinite(result.hostedRenderCount) && Number.isFinite(result.imagesSent)) {
          stats.keyframeCount += result.hostedRenderCount;
          submitted.push({ time: performance.now(), count: result.imagesSent });
        } else if (!result.fromCache) { stats.telemetryComplete = false; }
        if (result.renderUrl && result.renderUrl !== layer?.url) { await load(result.renderUrl); if (layer) layer.url = result.renderUrl; }
        lastRefresh = performance.now(); referenceLive = latest?.landmarks; failures = 0;
      } catch { failures++; retryAt = performance.now() + Math.min(60000, interval * 2 ** failures); }
      finally { pending = false; }
    };
    const draw = now => {
      if (stopped) return;
      const canvas = canvasRef.current;
      if (canvas && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        }
        const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (layer && latest?.visible && now - latest.timestamp < 500 && warpGarment(ctx, layer, layer.anchors, latest.landmarks)) {
          stats.warpedFrames++; windowFrames++;
          if (!referenceLive) referenceLive = latest.landmarks;
          if (warmedAt === null) { warmedAt = now; frameWindow = now; }
          if (now - lastRefresh >= interval || (now - lastRefresh >= 8000 && poseDiverged(referenceLive, latest.landmarks, canvas.width, canvas.height))) refresh(now);
        }
      }
      if (now - frameWindow >= 3000) {
        stats.warpFps = windowFrames * 1000 / (now - frameWindow);
        stats.imagesSentPerMinute = stats.telemetryComplete ? submitted.filter(r => now - r.time < 60000).reduce((s, r) => s + r.count, 0) : null;
        publish();
        if (warmedAt !== null && now - warmedAt >= 6000 && stats.warpFps < 10) {
          fallback('Live try-on is below 10 fps. Showing the still image.'); return;
        }
        frameWindow = now; windowFrames = 0;
      }
      raf = requestAnimationFrame(draw);
    };
    publish();
    (async () => {
      try {
        await load(renderUrl);
        if (stopped) return;
        layer.url = renderUrl;
        handle = startPoseTracking(video, result => {
          latest = result;
          if (!result.visible) stats.poseDropouts++;
          if (result.error) fallback(result.error);
        });
        const ready = await handle.ready;
        if (!ready || stopped) return;
        setActive(true); stats.status = 'live'; frameWindow = performance.now();
        raf = requestAnimationFrame(draw);
      } catch (error) { fallback(error.message || 'Live try-on unavailable. Showing the still image.'); }
    })();
    return () => { stopped = true; stopPoseTracking(handle); cancelAnimationFrame(raf); stats.status = 'stopped'; publish(); };
  }, [enabled, renderUrl, selectionKey, canvasRef, refreshIntervalMs, imagesPerRequest]);
  return { active, notice };
}
