---
name: rightmodeler
description: >-
  Find where an agent pipeline can swap frontier models for cheaper ones without
  losing quality. Ingests the user's agent trace logs, replays successful steps
  through cheaper models on OpenRouter, and uses an LLM-as-judge to check the
  cheaper output matches the original. Handles multi-step / tool-calling / looping
  pipelines by re-executing the real code with the model swapped, then reports
  per-step cost savings, quality scores, and cascade risks in a TUI + report.
  Use when the user wants to cut model spend, right-size models per task, benchmark
  cheaper model substitutions, or analyze an agentic pipeline (LangGraph, Codex,
  Claude Code, raw SDK) for cost optimization. Not a prompt-improvement or
  prompt-rewriting tool — it changes which model runs a step, never the prompt.
---

# rightmodeler

Prove, from the user's _own_ runs, where a cheaper model can replace an expensive
one without hurting task quality — then hand them an approved swap plan and the
dollar savings.

The premise (from the user):

> User uploads agent trace logs + an OpenRouter API key + codebase access. For each
> successful logged step, re-run the system prompt + logged input through a cheaper
> model and use LLM-as-judge to check the output is similar. Some pipelines are
> multi-step / tool-calling / looping — those need a **code-execution** replay, not
> a single-shot prompt, because a small quality drop at step A can break step E.

## Golden rules

1. **The original run is the reference, not ground truth from a benchmark.** Judge
   the cheap model against the user's _accepted_ output for that exact step.
2. **Never let the judge be the same model family as either candidate** — self-preference
   bias inflates the expensive model. Use a neutral third-family judge.
3. **Prefer the strongest available signal per step**, in this order: deterministic
   check (tests/build/schema/valid tool call) → reference comparison → trajectory
   eval → calibrated LLM-judge → abstain. Do not default to LLM-judge. See
   [reference/judge.md](reference/judge.md).
4. **Single-shot replay is only valid for single-shot steps.** If a step is part of a
   loop, calls tools, or feeds a downstream step, it must go through the
   code-execution E2E replay so cascading failures surface. See
   [reference/replay.md](reference/replay.md).
5. **Nothing destructive runs against the real repo.** All code execution happens in a
   throwaway `git worktree` + ephemeral venv; side-effecting tools are mocked from the
   recorded trace unless the user opts into live execution.
6. **The user approves every swap.** We recommend and rank; they tip the scale.

## Local engine workflow

The installed skill is the orchestration layer. The repository pipeline owns
contracts, evaluator policy, scorecards, release gates, remediation evidence,
and corpus versioning. From a repository root, the default imported-result path
stays offline:

```bash
uv run python /path/to/rightmodeler/skills/rightmodeler/scripts/workflow.py \
  --repo . \
  --cases .rightmodeler/corpus/benchmark-cases.json \
  --candidate .rightmodeler/input/candidate-results.json \
  --family structured-check
```

This runs the pipeline benchmark evaluator, writes an immutable snapshot, and
renders the same snapshot gates and scorecards into a report. Use
`--family reference-freeform`, `tool-trajectory`, or `repo-fix` for the other
evaluation families. For `repo-fix`, also pass `--repo-target`.

Provider replay, remediation diagnosis, approval, apply, rollback, and corpus
publication are explicit follow-up commands. The workflow runner does not call
them implicitly. Use the commands in [reference/replay.md](reference/replay.md)
and the pipeline README when you intentionally want those actions.

## Prerequisites (check first)

Run all commands below from the skill root (`rightmodeler`).

```bash
uv sync
uv run python scripts/preflight.py
```

This verifies: `OPENROUTER_API_KEY` is set (and has credits), Python deps are
installable, and prints what's missing. First look for `OPENROUTER_API_KEY` in the
process environment, then in the user's project root `.env`. If the key is still
absent, ask the user to add:

```env
OPENROUTER_API_KEY=...
```

to their project root `.env` or `export OPENROUTER_API_KEY=...` in this session,
then continue after they reply instead of making them invoke the skill again.

If the user pastes the key in chat, write it to the project root `.env` once and
let the scripts pick it up from there (they do automatically). Do not re-`export`
the key inline in every shell command — shell state doesn't persist between
commands, and inlining embeds the secret throughout the session transcript.

If `uv` is unavailable, fall back to a plain venv install:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Use `uv run python` for every script call below, or `.venv/bin/python` if you
used the fallback install.

## Workflow

Four phases, matching the design: **detect → analyze → brute-force → result.**

### Phase 0 — Detect & gather inputs

Establish the baseline. Confirm with the user (ask, don't assume):

- **Traces**: path to the uploaded agent trace logs. Autodetect format with
  `scripts/ingest.py --detect <path>` (supports LangSmith, OTel GenAI, OpenInference,
  OpenAI JSONL, Braintrust, Langfuse, Claude Code, Codex — see
  [reference/trace-formats.md](reference/trace-formats.md)). If the traces live in a
  log store (CloudWatch, Datadog, GCP Logging), triage them first — most app logs
  contain request metadata but not the LLM inputs/outputs needed for replay; see the
  log-store section of trace-formats.md. If no usable traces exist but the app
  persists LLM outputs in a database, reconstruct a corpus instead — see
  [reference/corpus-reconstruction.md](reference/corpus-reconstruction.md). If
  there are no logs at all, set up capture (copy `scripts/capture.py` into the
  app, or a LiteLLM/proxy logging route — see the capture section of
  trace-formats.md) and resume once representative traffic has been collected.
- **Codebase**: repo dir, only needed for multi-step/tool/loop pipelines. If absent,
  you can still do per-step replay for single-shot steps.
- **Constraints**: model allowlist/denylist, quality floor, providers to avoid,
  high-risk task families to always abstain on.

Only ask for what is missing. If the API key, trace path, or codebase path is
already available, keep going in the same run.

The uploaded traces should be runs on a **high-quality model** (that's the whole
point — we're trying to match a good baseline with a cheaper model). If the traces
are already on a cheap/mixed model, warn the user the baseline is weak.

### Phase 1 — Analyze (map the pipeline)

```bash
uv run python scripts/ingest.py \
  <traces-path> --out .rightmodeler/normalized.json
uv run python scripts/analyze.py \
  .rightmodeler/normalized.json --codebase <dir> --out .rightmodeler/pipeline.json
```

`analyze.py` produces the pipeline map: ordered steps, the model used per step,
whether each step is single-shot vs multi-step/tool/loop, detected **task families**
(PR summary, test-gen, SQL-gen, tool-using agent…), the current cost per family, and
the strongest available evaluator per step. Read `pipeline.json` and summarize it to
the user before spending money.

### Phase 2 — Replicate & brute-force (find cheaper swaps)

For each step/task family, shortlist candidate cheaper models and test them:

```bash
uv run python scripts/orchestrate.py \
  .rightmodeler/pipeline.json \
  --normalized .rightmodeler/normalized.json \
  --quality-floor 0.9 \
  --candidates auto \
  --out .rightmodeler/results.json
```

`orchestrate.py` runs the two-stage strategy the user chose:

1. **Per-step shortlist** — for single-shot steps, replay the step's system prompt +
   input through each candidate (`replay_step.py`), judge vs the accepted output
   (`judge.py`), keep the cheapest model above the quality floor.
2. **E2E confirm (code-execution)** — for multi-step/tool/loop steps, or to confirm a
   shortlisted swap doesn't cascade, re-run the real pipeline with the model swapped
   at that step (`run_pipeline.py`, in a sandboxed worktree) and judge the trajectory
   - final output. This is what catches "small drop at A breaks E."

Candidate shortlisting is automatic (`scripts/shortlist.py`): pull OpenRouter
`/models`, filter to models that support the step's needs (tool calling, structured
output, context length) and cost strictly less than the current model, test the
cheapest N. See [reference/openrouter.md](reference/openrouter.md).

Run this in the background if the fleet is large; stream progress to the user.
`orchestrate.py` checkpoints `--out` after every step, so a long run is observable
(read the partial results file) and a crash loses nothing. Progress lines on stderr
are numbered `i/N`. To re-test a subset after a fix (new judge, corrected client,
one family), use `--only <family|step_id> …` and overlay onto the previous run with
`--merge-into .rightmodeler/results.json` — don't hand-edit results files.

If the final summary prints a `[warn] <model> errored on ALL n calls` line, that
candidate was never actually tested — its 0.00 scores are API failures, not quality
verdicts. Fix the cause (see `candidate_errors` in results.json for the error text)
and re-run those steps with `--only`/`--merge-into` before drawing conclusions.

### Phase 3 — Result (TUI + report)

Launch the interactive per-step approval TUI, then export:

```bash
uv run python scripts/tui.py \
  .rightmodeler/results.json
uv run python scripts/report.py \
  .rightmodeler/results.json --out .rightmodeler/report.md
```

The TUI shows, per step: current model, best cheaper candidate, cost delta, quality
score, evidence type, confidence, and a cascade-risk flag — and lets the user
**approve / reject / hold** each swap. Approved swaps are written to
`.rightmodeler/decisions.json`; `report.py` renders the final Markdown report +
machine-readable JSON (total savings, per-family recommendations, risks, abstentions).

When there's no interactive terminal for the TUI (agent-driven session), skip it:
present the report's **per-family** table in chat (when families have multiple
cases, the per-family pass-rate table is the decision table — single-step wins are
noise), collect approve/reject per family conversationally, and write
`.rightmodeler/decisions.json` (`{"<step_id>": "approved" | "rejected" | "hold"}`)
yourself before re-running `report.py`.

## Guardrails & failure modes

- **Cascading failure**: flag the _earliest_ step whose quality drops below floor even
  if the final output still looks OK — that's the cascade seed. Weight early-step
  regressions higher. Always E2E-confirm before recommending a swap on a step that
  feeds others.
- **Judge reliability**: run each judgment with output order swapped; keep only
  order-consistent verdicts. For important swaps, require two independent judges to
  agree. Use a small ordinal scale (equivalent / minor-drift / divergent), not 0–100.
- **Cost of the analysis itself**: brute-forcing costs tokens. Estimate and show the
  projected OpenRouter spend before Phase 2; cap concurrency to avoid 429s; compare
  `usage.cost`, never token counts across models (different tokenizers).
- **Weak evidence → abstain.** Sparse data, high-risk task family (auth, payments,
  migrations, prod-mutating tools), or no calibration → recommend no swap and say why.

## rightmodeler agent (after a successful run)

Once a run has produced a report the user trusts, offer the **rightmodeler agent**:
a headless scheduled watcher (`scripts/agent.py install`) that re-checks the model
catalog on a cron cadence, evaluates only what changed since the last run, guards
the incumbent model against delisting and price rises, and opens an evidence-backed
**draft PR** when a swap clears the gates in `rightmodeler.policy.json`
(quality floor, min saving, per-run budget, never-touch list, schedule). It never
auto-merges; closing its PR is a lasting no. Everything stays on the user's machine —
the PR is the only egress. `agent.py status` shows the run ledger, spend, and a
staleness warning if scheduled runs stop. Spec: `docs/specs/rightmodeler-agent-v1.md`.

## Files

- `scripts/` — `preflight`, `capture`, `ingest`, `analyze`, `shortlist`, `replay_step`,
  `replay`, `judge`, `run_pipeline`, `orchestrate`, `workflow`, `tui`, `report`, `agent`,
  `agent_ledger`.
- `reference/` — deep docs loaded on demand: `trace-formats.md`, `replay.md`,
  `judge.md`, `openrouter.md`, `corpus-reconstruction.md`.
- Working output lives under `.rightmodeler/` in the user's project (gitignore it).

Full product context (task-family detection, confidence bands, non-goals) is in the
repo's `PRD.md` — consult it when scoping recommendations.
