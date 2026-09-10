# Report alignment handoff (superseded scope)

- `012ef3f`: service rename and compatibility aliases; 33 backend tests passed.
- `246743c`: evaluator and both real CPU slice outputs landed. The source was
  uncommitted when the runs began, so the provenance's `git_commit` records the
  preceding rename commit; it is not a claim the evaluator existed in that commit.
  The evaluator and collector source used are preserved by the following commit.
  Its subsequently corrected empty-label edge case does not affect these runs.
- The timing helper and React commit observer are preserved but are **not wired
  into the camera or UI**. The latency reporter has not been acceptance-tested.
- The packet inventory and its test source are preserved as **partial, unvalidated
  tooling**. No real network capture or privacy conclusion was produced.
- These remaining report-alignment tasks are deferred indefinitely by the next
  work package. No deployment should claim camera-to-display measurements or a
  completed biometric egress audit on the basis of this tooling.

The CPU results are evaluations of explicitly selected slices, with training
overlap unknown; they are not verified held-out historical reproductions.

Baseline frontend build succeeded with existing warnings after installing using
`npm ci --legacy-peer-deps`; plain `npm ci` encounters the pre-existing CRA 5 /
TypeScript 5 peer conflict. The four regenerated MediaPipe files were restored.
