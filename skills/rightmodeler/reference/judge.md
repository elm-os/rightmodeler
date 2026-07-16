# Evaluation: choose the strongest signal, judge carefully

Do **not** default to LLM-as-judge. Per step, `analyze.py` picks the strongest available
evaluator; only fall through to the judge when nothing stronger exists.

## Evaluator priority

1. **Deterministic verifier** (highest confidence): unit tests pass, build/typecheck/lint
   succeeds, JSON-schema valid, required fields present, tool call is well-formed, no
   runtime error, latency/retries within threshold. Use whenever the task is verifiable.
2. **Reference-based comparison**: we _have_ the accepted original output — compare the
   candidate against it for semantic match, not lexical overlap. This is the default for
   this product because every logged successful step is a reference.
3. **Agent trajectory evaluation**: correct tool selection, correct args, constraint
   adherence, no loops, error recovery, step count, final answer reflects tool results.
4. **Calibrated LLM-as-judge**: only for fuzzy outputs (summaries, explanations, drafts,
   plans, support replies) where 1–3 don't apply.
5. **Abstain**: sparse data / high-risk family / no calibration → recommend no swap.

## LLM-judge design (`judge.py`)

Framing: **reference-guided binary/ordinal verdict.** Give the judge (a) the task/intent,
(b) the original accepted output as the reference, (c) the candidate cheap-model output.
Ask for `equivalent | minor_drift | divergent` + a one-line justification. Structured
JSON output, temperature 0.

For tool calls / structured outputs, decompose — don't hand the blob to a prose judge:

- **Deterministic pre-check first.** Compare tool name and arg _keys_ with set logic;
  compare arg _values_ with typed rules (numeric tolerance, unit/format normalization,
  order-insensitive lists, commutativity). Only escalate genuinely semantic values
  (free-text args, paraphrasable strings) to the LLM.
- Score **per argument**, not per call — that granularity feeds cascade detection.
- Rubric rules: reorderable args equivalent; missing-optional-with-default equivalent;
  wrong/hallucinated required arg = hard fail; extra non-conflicting detail acceptable,
  contradiction not.

## Bias mitigations (mandatory)

| Bias                           | Mitigation                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Position** (favors slot A/B) | Run both orderings; keep only order-consistent verdicts; randomize order.                                       |
| **Verbosity/length**           | Penalize length in rubric; require per-criterion justification; structured JSON verdict.                        |
| **Self-preference**            | Judge must be a **different family** than both candidates. Never judge the expensive model with its own family. |

Grading scale: use the small ordinal scale above (or 0–5). Avoid 0–100 — human alignment
is best on coarse scales. For important swaps require **two independent judges to agree**
before accepting a step verdict (cuts label noise materially).

## Cascade detection

Errors compound: a weak early step can pass its own check yet break a downstream step, and
the _visible_ failure is far from the root cause. So:

- Run reference-guided per-step scoring across the whole trajectory.
- Flag the **earliest** step whose semantic-equivalence score drops below the floor — even
  if the final output still looks OK. That early sub-threshold step is the cascade seed.
- Weight early-step regressions higher than late ones.
- Confirm with the E2E code-execution replay ([replay.md](replay.md)) before recommending
  any swap on a step that feeds others.

## Calibration

Judge tier: a frontier model, outside the family of both candidates, temperature 0,
structured output. If the user has any human labels, keep only judges correlating with
them (r ≥ 0.8), report Cohen's κ, and recompute κ when swapping judge or candidate models.
Maintain a small gold set of step outputs for spot-checks. Report **low confidence** when
no calibration exists.

**Severity check for open-ended tasks.** Reference-judging is harsh on open-ended
generation (personas, emotional analyses, free-form summaries): two equally good
outputs can legitimately diverge, and the judge reads divergence as failure. When a
family scores near-zero for _every_ candidate — including strong ones — suspect judge
strictness before concluding "no viable swap". Cheap baseline: replay a few cases
through the **current** model itself and judge that output against the stored
reference. If the same-model baseline also scores below the floor, the judge (or the
task's inherent variance) is the bottleneck, and verdicts for that family should be
reported as low-confidence rather than as evidence against every candidate.

## Confidence bands (feeds the report)

- **High**: deterministic or strongly reference-backed evidence across enough examples.
- **Medium**: reference-backed or calibrated-judge evidence, moderate sample.
- **Low**: sparse data, fuzzy judging, weak calibration, high variance.
- **Abstain**: evidence insufficient or task risk too high (auth, payments, migrations,
  prod-mutating tools).

Sources: LLM-as-judge surveys, position/verbosity/self-preference bias papers, reference-
guided judging, trajectory/failure-attribution research, Judge's-Verdict calibration.
