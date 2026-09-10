// Browser processing/render estimates, never physical display timestamps.
export const PROBE_STAGES = ['frame_sampled', 'inference_done', 'state_applied', 'paint_estimate'];
export const MAX_PROBE_MARKS = 100000;
let installed = false;
let listening = false;
let records = [];
let overflow = 0;
let session = '';
let counter = 0;

export const probeEnabled = () => typeof window !== 'undefined' && window.__MIRROR_PROBE__ === true;
const newSession = () => `${performance.timeOrigin}-${Math.random().toString(36).slice(2)}`;
const collect = ({ detail }) => {
  if (!probeEnabled() || !detail || detail.session !== session) return;
  if (records.length >= MAX_PROBE_MARKS) { overflow += 1; return; }
  // Whitelist timing fields; never copy arbitrary event payloads or biometrics.
  const { stage, id, pipeline, t, reason } = detail;
  if (![...PROBE_STAGES, 'dropped'].includes(stage) || !Number.isFinite(t) ||
      typeof id !== 'string' || !['hand', 'face'].includes(pipeline)) return;
  records.push({ session, stage, id, pipeline, t, ...(reason ? { reason } : {}) });
};

export function installProbeCollector() {
  if (typeof window === 'undefined') return;
  if (!installed) {
    installed = true;
    session = newSession();
    window.__MIRROR_PROBE_DUMP__ = () => records.map(r => JSON.stringify(r)).join('\n');
    window.__MIRROR_PROBE_STATS__ = () => ({ session, marks: records.length, overflow, capacity: MAX_PROBE_MARKS });
    window.__MIRROR_PROBE_CLEAR__ = () => { records = []; overflow = 0; session = newSession(); };
    window.__MIRROR_PROBE_START__ = () => { window.__MIRROR_PROBE__ = true; installProbeCollector(); };
    window.__MIRROR_PROBE_STOP__ = () => {
      window.__MIRROR_PROBE__ = false;
      window.removeEventListener('mirror:probe', collect);
      listening = false;
      // Invalidate outstanding inference/paint callbacks, retaining the dump.
      session = newSession();
    };
  }
  if (probeEnabled() && !listening) {
    window.addEventListener('mirror:probe', collect);
    listening = true;
  }
}

export function probeMark(stage, trace, reason) {
  if (!probeEnabled() || !trace || trace.closed || trace.session !== session) return;
  installProbeCollector();
  window.dispatchEvent(new CustomEvent('mirror:probe', {
    detail: { stage, id: trace.id, session, pipeline: trace.pipeline, t: performance.now(), reason },
  }));
  if (stage === 'paint_estimate' || stage === 'dropped') trace.closed = true;
}

export function beginProbe(pipeline) {
  if (!probeEnabled()) return null;
  installProbeCollector();
  const trace = { session, pipeline, id: `${session}:${pipeline}:${++counter}`, closed: false };
  probeMark('frame_sampled', trace);
  return trace;
}

export function dropProbe(trace, reason) { probeMark('dropped', trace, reason); }

export function estimatePaint(trace, stillCurrent, insideAnimationFrame = false) {
  if (!probeEnabled() || !trace || trace.closed) return;
  const finish = () => {
    if (document.visibilityState === 'hidden') dropProbe(trace, 'hidden');
    else if (!stillCurrent()) dropProbe(trace, 'superseded');
    else probeMark('paint_estimate', trace);
  };
  // Cursor writes already run inside RAF. React layout effects need two RAFs
  // so their estimate cannot execute in the immediately upcoming pre-paint RAF.
  requestAnimationFrame(insideAnimationFrame ? finish : () => requestAnimationFrame(finish));
}
