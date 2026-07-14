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
