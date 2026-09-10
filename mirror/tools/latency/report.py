"""Summarize browser frame-sampling to paint-estimate JSONL, separately by pipeline."""
import collections
import json
import math
from pathlib import Path
import sys

import numpy as np

STAGES = ['frame_sampled', 'inference_done', 'state_applied', 'paint_estimate']


def summarize(lines):
    groups = collections.defaultdict(list)
    discarded = collections.Counter()
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict) or not isinstance(row.get('id'), str):
                raise ValueError()
            groups[row['id']].append(row)
        except (ValueError, TypeError):
            discarded['malformed_lines'] += 1
    complete = collections.defaultdict(list)
    for rows in groups.values():
        pipelines = {r.get('pipeline') for r in rows}
        sessions = {r.get('session') for r in rows}
        if len(pipelines) != 1 or not pipelines <= {'hand','face'} or len(sessions) != 1:
            discarded['invalid_groups'] += 1; continue
        valid_time = lambda t: isinstance(t, (float,int)) and not isinstance(t,bool) and math.isfinite(t)
        if any(not valid_time(r.get('t')) or r.get('stage') not in STAGES + ['dropped'] for r in rows):
            discarded['invalid_groups'] += 1; continue
        stages = [r['stage'] for r in rows]
        if len(stages) != len(set(stages)) or any(b['t'] < a['t'] for a,b in zip(rows, rows[1:])):
            discarded['invalid_groups'] += 1; continue
        ordered = [STAGES.index(s) for s in stages if s != 'dropped']
        if ordered != sorted(ordered):
            discarded['invalid_groups'] += 1; continue
        if 'dropped' in stages:
            if stages[-1] != 'dropped' or 'paint_estimate' in stages:
                discarded['invalid_groups'] += 1; continue
            reason = rows[-1].get('reason', 'unspecified')
            discarded[f'dropped_{reason}'] += 1; continue
        if stages != STAGES:
            discarded['incomplete_groups'] += 1; continue
        complete[next(iter(pipelines))].append({r['stage']:r['t'] for r in rows})
    return complete, discarded


def report(lines):
    complete, discarded = summarize(lines)
    print('Browser timing estimate only; not physical camera-to-display latency.')
    for pipeline in ['hand','face']:
        samples = complete[pipeline]
        print(f'\nPipeline: {pipeline}')
        print(f"{'stage pair':<34} {'n':>6} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>8}")
        for a,b in [('frame_sampled','paint_estimate'), ('frame_sampled','inference_done'), ('inference_done','paint_estimate')]:
            values = [r[b]-r[a] for r in samples]
            stats = [*np.percentile(values, [50,95,99], method='linear'), max(values)] if values else []
            formatted = ' '.join(f'{v:7.0f}ms' for v in stats) if stats else '     n/a      n/a      n/a      n/a'
            print(f'{a + " -> " + b:<34} {len(values):6d} {formatted}')
    print('\nExcluded: ' + (', '.join(f'{k}={v}' for k,v in sorted(discarded.items())) or 'none'))
    print('Collector overflow is available separately from __MIRROR_PROBE_STATS__(); retain it with the dump.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python report.py probe.jsonl')
    with Path(sys.argv[1]).open(encoding='utf-8-sig') as source:
        report(source)
