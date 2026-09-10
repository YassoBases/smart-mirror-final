import { useCallback, useLayoutEffect, useRef } from 'react';
import { dropProbe, estimatePaint, probeMark } from '../utils/latencyProbe';

// Observe existing commits; never set React state to manufacture a timing sample.
export default function useVisualCommitProbe(snapshot, visible) {
  const committed = useRef(snapshot);
  const visibleRef = useRef(visible);
  const pending = useRef(null);
  useLayoutEffect(() => {
    committed.current = snapshot;
    visibleRef.current = visible;
    const entry = pending.current;
    if (!entry || entry.trace.closed || entry.applied) return;
    if (!visible) { dropProbe(entry.trace, 'hidden'); return; }
    if (entry.expected !== snapshot) return;
    entry.applied = true;
    probeMark('state_applied', entry.trace);
    estimatePaint(entry.trace, () => pending.current === entry && visibleRef.current && committed.current === entry.expected);
  });
  useLayoutEffect(() => () => dropProbe(pending.current?.trace, 'uncommitted'), []);
  const queue = useCallback((trace, expected) => {
    if (!trace) return;
    dropProbe(pending.current?.trace, 'superseded');
    if (!visibleRef.current) { dropProbe(trace, 'hidden'); return; }
    if (expected === committed.current) { dropProbe(trace, 'unchanged'); return; }
    const entry = { trace, expected, applied: false };
    pending.current = entry;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pending.current === entry && !entry.applied) dropProbe(trace, 'uncommitted');
    }));
  }, []);
  return { queue, committed };
}
