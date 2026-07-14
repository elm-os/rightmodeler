# pipeline

Python CLI for ingesting historical runs, producing analysis artifacts, and writing
recommendation-report JSON files into `.rightmodeler/`.

## Build a corpus

Compile reviewed case definitions against an accepted historical run bundle:

```bash
uv run python -m pipeline corpus build \
  --input .rightmodeler/input/historical-run-bundle.json \
  --definition corpus-definition.json
```

The command writes an immutable corpus manifest and benchmark-case references
under `.rightmodeler/corpus/`. It stays offline and rejects missing or
unaccepted source runs.

## Review corpus drift

Compare a current candidate definition and run bundle with a parent corpus:

```bash
uv run python -m pipeline corpus detect-drift \
  --parent-manifest .rightmodeler/corpus/parent-manifest.json \
  --parent-bundle .rightmodeler/input/parent-bundle.json \
  --candidate-bundle .rightmodeler/input/candidate-bundle.json \
  --candidate-definition corpus-definition-v2.json \
  --output .rightmodeler/corpus/drift-proposal.json
```

Drift detection only creates a proposal. Approve it explicitly, then publish a
new version:

```bash
uv run python -m pipeline corpus approve-drift \
  --proposal .rightmodeler/corpus/drift-proposal.json \
  --output .rightmodeler/corpus/approved-drift.json \
  --actor ameya
uv run python -m pipeline corpus publish \
  --parent-manifest .rightmodeler/corpus/parent-manifest.json \
  --candidate-bundle .rightmodeler/input/candidate-bundle.json \
  --candidate-definition corpus-definition-v2.json \
  --proposal .rightmodeler/corpus/approved-drift.json \
  --manifest-output .rightmodeler/corpus/manifest-v2.json \
  --cases-output .rightmodeler/corpus/benchmark-cases-v2.json
```

Publishing preserves the parent digest and refuses an exposed holdout without
replacement coverage. Existing manifests and snapshots are never rewritten.

## Evaluate Imported Structured Results

Evaluate imported candidate results against a compiled corpus without network
access or evaluator spend:

```bash
uv run python -m pipeline benchmark evaluate \
  --cases .rightmodeler/corpus/benchmark-cases.json \
  --candidate .rightmodeler/input/candidate-results.json \
  --output .rightmodeler/evaluation/benchmark-snapshot.json
```

The command validates the candidate contract, runs JSON/schema/required-field
checks, and emits a content-addressed snapshot with terminal verdicts,
abstentions, imported cost, evidence references, and timing availability.

Snapshots also include v1 scorecards and release gates. Add frozen labels to a
benchmark case when measuring recommendation precision and safe-opportunity
recall:

```json
"labels": {
  "recommendation": "safe",
  "required_abstention": false
}
```

Add `baseline_duration_ms` to a candidate result for paired speed metrics. The
snapshot reports quality, safety, coverage, confidence, cost, and remediation
status separately. Missing labels, remediation proof, or paired timing remain
`unavailable` or `review`; the evaluator never infers them from other fields.

Evaluate freeform results with an explicit reference:

```bash
uv run python -m pipeline benchmark evaluate \
  --family reference-freeform \
  --cases .rightmodeler/corpus/benchmark-cases.json \
  --candidate .rightmodeler/input/candidate-results.json \
  --output .rightmodeler/evaluation/benchmark-snapshot.json
```

Freeform results may carry a frozen human verdict with reviewer references and
an agreement state. Reference evidence without a calibrated verdict, disputed
reviews, and missing references abstain instead of invoking a semantic judge.

Evaluate imported tool trajectories against a recorded reference trajectory:

```bash
uv run python -m pipeline benchmark evaluate \
  --family tool-trajectory \
  --cases .rightmodeler/corpus/benchmark-cases.json \
  --candidate .rightmodeler/input/candidate-results.json \
  --output .rightmodeler/evaluation/benchmark-snapshot.json
```

The trajectory evaluator compares tool names, arguments, order, retries, loop
markers, recovery, terminal state, and exact final output. It derives
downstream, loop, and recovery risk flags without replaying tools.

## Diagnose a remediation

Turn a failed or weak snapshot into one primary issue class and next action
without changing the repository:

```bash
uv run python -m pipeline remediation diagnose \
  --snapshot .rightmodeler/evaluation/benchmark-snapshot.json \
  --output .rightmodeler/remediation/evidence.json
```

Pass `--proposal`, `--post-fix-snapshot`, `--holdout-snapshot`, and
`--validation` when those artifacts exist. The output is validated against the
`remediation-evidence` contract. It stays `review` or `draft` until an
actionable change, improved target gate, stable gates, and passed validation
are all present. Diagnosis never applies a diff.

Approve, apply, and roll back are separate explicit local actions. They use an
append-only lifecycle artifact and never create Git history or remote state:

```bash
uv run python -m pipeline remediation approve \
  --evidence .rightmodeler/remediation/evidence.json \
  --repo . \
  --actor ameya
uv run python -m pipeline remediation apply \
  --evidence .rightmodeler/remediation/evidence.json \
  --repo . \
  --actor ameya
uv run python -m pipeline remediation rollback \
  --evidence .rightmodeler/remediation/evidence.json \
  --repo . \
  --actor ameya
```

Approval records the clean base revision and affected-file digests. Apply
refuses stale or dirty state, checks the declared patch scope, runs the
declared validation commands, and restores the recorded pre-apply files when
validation fails. Rollback refuses if affected files no longer match the
recorded applied digests.

Evaluate a repository-fix candidate in an isolated worktree:

```bash
uv run python -m pipeline benchmark evaluate \
  --family repo-fix \
  --repo /path/to/repository \
  --cases .rightmodeler/corpus/benchmark-cases.json \
  --candidate .rightmodeler/input/candidate-results.json \
  --output .rightmodeler/evaluation/benchmark-snapshot.json
```

The repository must be clean and at the declared Git revision. Validation
commands use argv arrays with bounded timeouts, run only in a disposable
worktree, and record exit status, output summaries, timing, patch scope, and
patch evidence. The real repository is not modified.
