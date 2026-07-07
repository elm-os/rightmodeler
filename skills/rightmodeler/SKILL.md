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
  Claude Code, raw SDK) for cost optimization.
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
  [reference/trace-formats.md](reference/trace-formats.md)).
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
.venv/bin/python scripts/ingest.py \
  <traces-path> --out .rightmodeler/normalized.json
.venv/bin/python scripts/analyze.py \
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
.venv/bin/python scripts/orchestrate.py \
  .rightmodeler/pipeline.json \
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

### Phase 3 — Result (TUI + report)

Launch the interactive per-step approval TUI, then export:

```bash
.venv/bin/python scripts/tui.py \
  .rightmodeler/results.json
.venv/bin/python scripts/report.py \
  .rightmodeler/results.json --out .rightmodeler/report.md
```

The TUI shows, per step: current model, best cheaper candidate, cost delta, quality
score, evidence type, confidence, and a cascade-risk flag — and lets the user
**approve / reject / hold** each swap. Approved swaps are written to
`.rightmodeler/decisions.json`; `report.py` renders the final Markdown report +
machine-readable JSON (total savings, per-family recommendations, risks, abstentions).

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

## Files

- `scripts/` — `preflight`, `ingest`, `analyze`, `shortlist`, `replay_step`, `judge`,
  `run_pipeline`, `orchestrate`, `tui`, `report`.
- `reference/` — deep docs loaded on demand: `trace-formats.md`, `replay.md`,
  `judge.md`, `openrouter.md`.
- Working output lives under `.rightmodeler/` in the user's project (gitignore it).

Full product context (task-family detection, confidence bands, non-goals) is in the
repo's `PRD.md` — consult it when scoping recommendations.
