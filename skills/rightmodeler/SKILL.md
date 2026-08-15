---
name: rightmodeler
license: MIT
description: >-
  Find where an agent pipeline can swap frontier models for cheaper ones without
  losing quality. Drive the installed rightmodeler TypeScript CLI through its
  resumable pipeline, interpret its machine protocol, present per-family verdicts,
  and open a reviewed model-swap pull request when the evidence supports one. Use
  when the user wants to cut model spend, right-size models per task, benchmark
  cheaper model substitutions, or analyze an agentic pipeline for cost optimization.
---

# rightmodeler TypeScript CLI runbook

**Current path:** use the installed TypeScript CLI, published on npm as
`rightmodeler` (workspace package `@rightmodeler/cli`) with bin `rightmodeler`.
The legacy Python engine has been retired; the CLI is the only engine.

The CLI is resumable. It stores checkpoints and reports under `.rightmodeler/` in
the target repository unless `--store` overrides that location. Re-run the same
command after satisfying a named input or budget boundary. Do not delete the store
to restart.

Read the documentation shipped with the installed CLI before driving it:

- `harness/packages/rightmodeler/docs/getting-started.md`
- `harness/packages/rightmodeler/docs/commands.md`
- `harness/packages/rightmodeler/docs/exit-codes.md`
- `harness/packages/rightmodeler/docs/evaluators.md`
- `harness/packages/rightmodeler/docs/modeb.md`

In an installed dependency, the same files are under
`node_modules/@rightmodeler/cli/docs/`. The shipped docs describe the version that
is actually installed and take precedence over this runbook if versions differ.

## 1. Establish scope and goal

Ask only for inputs that are not already known:

- The repository root.
- The trace file path. The CLI accepts OTel GenAI JSON and OpenAI JSONL.
- The goal and stopping stage. Use `report` for a complete recommendation run.
- The OpenAI-compatible provider base URL and the name of the environment variable
  that already contains its API key.
- The maximum allowed replay spend in US dollars.
- Model, provider, quality, or ownership constraints that affect the run.

Never ask for an API key value. The user sets the named environment variable in
their own shell. Do not echo, persist, or inline its value.

## 2. Detect onboarding state

Run from any directory, but always pass an absolute repository path:

```bash
REPO=/absolute/path/to/repository
if [ -d "$REPO/.rightmodeler" ]; then
  echo "Existing rightmodeler state found. Resume from checkpoints."
else
  echo "No rightmodeler state found. Start onboarding."
fi
```

An existing `.rightmodeler/` means resume, not overwrite. Before spending money,
summarize whether this is a new or resumed run and restate the agreed scope.

## 3. Locate the CLI

Prefer an already installed bin. Then prefer the dependency-local bundled bin.
Fall back to the published package through `npx`:

```bash
if command -v rightmodeler >/dev/null 2>&1; then
  RIGHTMODELER=(rightmodeler)
elif [ -x ./node_modules/.bin/rightmodeler ]; then
  RIGHTMODELER=(./node_modules/.bin/rightmodeler)
else
  RIGHTMODELER=(npx --yes rightmodeler)
fi

"${RIGHTMODELER[@]}" --help
"${RIGHTMODELER[@]}" init --help
```

Both help commands must exit 0. If either exits 10 or greater, stop and report the
installation or command-line failure. There is no fallback engine.

## 4. Preview the plan

Previewing is read-only and needs neither traces nor provider credentials:

```bash
"${RIGHTMODELER[@]}" init --plan --output json --repo "$REPO"
```

Require exit 0. Parse stdout as one JSON object. Its `stages` array names each stage
and marks it `pending`, `stale`, or `complete`; `executedStages` must be empty.
Present the stage plan before starting the run. A parse failure is a runtime failure,
not an empty plan.

## 5. Run through the agreed stage

Set the agreed inputs. `THROUGH=report` runs the complete pipeline. The API key must
already exist in the environment variable named by `API_KEY_ENV`.

The spend cap is optional. Leave `MAX_COST_USD` empty to run uncapped: every case and
judge cell then runs to completion, which is the right choice when completeness and
evidence quality matter more than cost. Set a cap only when the operator wants a hard
stop; a capped run halts at the boundary with a named remedy and resumes after the cap
is raised.

```bash
TRACES=/absolute/path/to/traces.json
THROUGH=report
PROVIDER_BASE_URL=https://provider.example/v1
API_KEY_ENV=RIGHTMODELER_API_KEY
MAX_COST_USD=
RUN_LOG=$(mktemp)
ERROR_LOG=$(mktemp)

CAP_ARGS=()
if [ -n "$MAX_COST_USD" ]; then
  CAP_ARGS=(--max-cost-usd "$MAX_COST_USD")
fi

if "${RIGHTMODELER[@]}" init \
  --yes \
  --through "$THROUGH" \
  --traces "$TRACES" \
  --base-url "$PROVIDER_BASE_URL" \
  --api-key-env "$API_KEY_ENV" \
  "${CAP_ARGS[@]}" \
  --output jsonl \
  --repo "$REPO" \
  >"$RUN_LOG" 2>"$ERROR_LOG"; then
  EXIT_CODE=0
else
  EXIT_CODE=$?
fi
```

Parse every nonblank stdout line as one JSON object. Fail loudly with the line
number if any line is invalid. Events are `stage_started`, `stage_completed`,
`stage_skipped`, `warning`, and a final `result`. Preserve their order. Do not infer
success from the presence of output; branch on `EXIT_CODE` first.

This copy-pasteable parser validates the stream and prints each event:

```bash
node - "$RUN_LOG" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
for (let index = 0; index < lines.length; index += 1) {
  if (lines[index].trim() === "") continue;
  try {
    console.log(JSON.stringify(JSON.parse(lines[index])));
  } catch (error) {
    throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
  }
}
NODE
```

Completed stages are checkpointed. On a resumed run, `stage_skipped` is expected
for current stages. Keep the existing `.rightmodeler/` directory and re-run the
same command so stale or incomplete work resumes at the first boundary.

## 6. Interpret pipeline exit codes

Use the pipeline contract from
`harness/packages/rightmodeler/docs/exit-codes.md`:

- `0`: success with no actionable recommendation. Successful planning and partial
  `--through` runs also return 0.
- `1`: a complete `init` or `report` found an actionable recommendation.
- `2`: the run needs input at a resumable boundary.
- `3`: the cost budget was reached at a resumable boundary.
- `10` or greater: command-line or runtime failure.

For exit 0 or 1, require a final JSONL `result` event. For exit 1, also require
`result.recommendationExists` to be true. For a complete exit-0 run, require it to
be false. Partial runs can exit 0 without a recommendation.

For exit 2 or 3, parse stderr as exactly one JSON object with `code`, `message`, and
`remedy`. Stdout may contain valid events for stages completed before the boundary.

## 7. Pause at resumable boundaries

On exit 2, name the missing input from `message`, give the exact `remedy`, and wait
for the user or repository owner to provide it. Common remedies include adding
`--traces`, adding `--base-url`, naming an API-key environment variable with
`--api-key-env`, or supplying required confirmation configuration. Never guess a
missing value. Resume with the same store after the input is available.

On exit 3, report that the configured budget boundary stopped the run. Include the
error `message` and `remedy`, the configured `--max-cost-usd`, and the last completed
stage from stdout. Do not raise the budget without explicit user authorization.

On exit 10 or greater, report stderr and stop. Fix the command or runtime failure
before resuming. Do not reinterpret it as a recommendation or abstention.

## 8. Present the result

For exit 0 or 1, read the final result event and present one row per entry in
`familyOutcomes`. Include:

- Family identifier.
- Decision and whether it is an effective recommendation.
- Selected candidate, if any.
- Evaluator pass rates, availability, and worst-case bound.
- Confirmation status and any blocker.
- Abstention reason, if present.

Also report `reportPath`. A complete run normally writes:

```text
.rightmodeler/project/reports/report.md
.rightmodeler/project/reports/report.json
```

Treat family verdicts as the decision unit. Do not promote a single successful case
into a family recommendation. Exit 0 can still contain useful rejects and
abstentions; present them instead of saying that nothing happened.

## 9. Apply and watch a proven swap

Only proceed when the complete result has an effective recommendation. `apply`
runs the machine gates and opens a draft pull request. It does not merge.

First run the machine-gated dry run:

```bash
GITHUB_OWNER=example-org
GITHUB_REPO=example-repository
GITHUB_API_URL=https://api.github.com
GITHUB_TOKEN_ENV=GITHUB_TOKEN

"${RIGHTMODELER[@]}" apply \
  --owner "$GITHUB_OWNER" \
  --github-base-url "$GITHUB_API_URL" \
  --github-token-env "$GITHUB_TOKEN_ENV" \
  --dry-run \
  --output jsonl \
  --repo "$REPO"
```

Apply exit codes are command-specific: 0 means the dry run is clean or changes were
applied, 1 means a machine gate refused the change, and 10 or greater means a runtime
failure. If the dry run exits 0, run the same command without `--dry-run` to open the
draft pull request and request review from the resolved owners.

After the command returns the pull request number, watch one reconciliation pass:

```bash
PR_NUMBER=123
"${RIGHTMODELER[@]}" watch \
  --owner "$GITHUB_OWNER" \
  --github-repo "$GITHUB_REPO" \
  --pr "$PR_NUMBER" \
  --github-base-url "$GITHUB_API_URL" \
  --github-token-env "$GITHUB_TOKEN_ENV" \
  --output jsonl \
  --repo "$REPO"
```

Watch exits 0 when no action is needed, 1 when review or continuous-integration
actions were taken, 2 when another watcher holds the lock, and 10 or greater on a
runtime failure. Repeat watch on repository events or the project's schedule. The
resolved owners review the draft pull request and decide whether to merge. The CLI
must never merge it.
