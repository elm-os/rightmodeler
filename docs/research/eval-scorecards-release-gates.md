# Eval scorecards and release gates

## Scope

This note defines conservative v1 defaults for evaluating rightmodeler itself.
It covers the accuracy and speed of recommendations, remediation usefulness,
offline release checks, optional replay checks, and eval spend.

These are product defaults, not universal constants. A task family may tighten
them, but weakening a safety gate must be explicit in the benchmark manifest.

## Scorecard

Report quality, coverage, speed, remediation, and cost separately. Abstentions
do not count as correct recommendations and do not reduce the denominator for
coverage.

| Dimension   | Metric                                                                               | V1 target                                   |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Safety      | Unsafe substitution recommendations                                                  | `0`                                         |
| Accuracy    | Recommendation precision against frozen labels                                       | `>= 95%`                                    |
| Accuracy    | Recall of labeled safe downgrade opportunities                                       | `>= 80%`                                    |
| Quality     | Candidate pass rate within each eligible normal-risk family                          | `>= 90%` with no hard deterministic failure |
| Abstention  | Required abstains caught for high-risk or insufficient-evidence cases                | `100%`                                      |
| Diagnosis   | Primary remediation issue class matches the frozen label                             | `>= 90%`                                    |
| Remediation | Artifacts labeled proven that pass trigger, regression, and available holdout checks | `100%`                                      |
| Coverage    | Cases with a terminal verdict and evidence provenance                                | `100%`                                      |

Coverage reports the proportions that are recommended, rejected, abstained,
review-only, and unavailable. This prevents a system from appearing accurate by
abstaining on most of the corpus.

## Confidence defaults

A recommendation is eligible only when its family quality score is at least
`0.90` and no hard deterministic check fails.

- High: deterministic evidence across at least 20 cases, or strong reference or
  trajectory evidence across at least 30 cases; pass rate at least `0.95`; no
  hard failures; required evaluator agreement is present.
- Medium: deterministic, reference, or trajectory evidence across at least 10
  cases; pass rate at least `0.90`; no hard failures.
- Low: fewer than 10 cases, high variance, weak evaluator agreement, or judge
  evidence that is not sufficiently calibrated. Low confidence is visible but
  cannot pass a release recommendation gate.
- Abstain: high-risk family, missing required evidence, conflicting evaluators,
  uncalibrated freeform judgment, or no reproducible validation path.

A calibrated LLM judge can support medium confidence in v1 only when it has at
least 20 frozen human labels, correlation of at least `0.80`, Cohen's kappa of
at least `0.60`, and order-consistent verdicts. Judge evidence alone cannot
produce high confidence in v1.

## Speed

Use paired measurements from the same cases and environment.

- Primary model speed: candidate versus baseline `wall_clock_ms` at p50 and p95.
- Operational signals: model latency, step count, retry count, and tool duration
  when available.
- A candidate has no material speed regression when p95 wall time is no more
  than `20%` slower than baseline.
- rightmodeler may claim a candidate is faster only when paired median wall time
  improves by at least `10%` and p95 does not regress.
- The offline benchmark engine should not regress more than `25%` against its
  stored local fixture runtime on the same machine class.

If timing is absent, speed is `unavailable`. The report may still make a
quality-and-cost recommendation, but it cannot claim a speed improvement.

## Release gates

### Offline smoke

Run on every local check and in CI. It must make no network calls and incur zero
external spend. All schemas, deterministic fixtures, report generation, and
repeatability checks must pass. Any failure blocks release.

### Standard local benchmark

Run against the maintained frozen corpus before a product release. It must meet
the scorecard targets, produce zero unsafe recommendations, preserve all hard
deterministic checks, and emit a terminal verdict plus evidence for every case.
Insufficient sample size produces `review`, not a stronger confidence label.

### Optional replay suite

Replay is explicit and stays outside default CI. Non-deterministic cases use at
least three repetitions. Tool, loop, or downstream-dependent cases require
sandboxed end-to-end replay. Judge-backed verdicts require order consistency,
and actual spend must remain within the approved cap. Partial replay results can
inform a report but cannot pass the replay release gate.

### High-risk families

High-risk substitutions remain review-only or abstain in v1, even when their
checks pass. They cannot become release-ready recommendations through a global
override.

## Cost rails

- Offline smoke and standard imported-result benchmarks have an external cost
  budget of `$0`.
- Any provider-backed replay requires an explicit `max_cost_usd`; there is no
  implicit online-spend default.
- Before replay, show the projected request count and worst-case spend. Refuse
  to start when the projection exceeds the cap or cannot be bounded.
- Cache replay results by stable case, model, prompt, parameters, and evaluator
  identity so identical work is not purchased twice.
- Reserve worst-case headroom before each request, record authoritative provider
  cost afterward, and stop before the next request could exceed the cap.
- On budget exhaustion, persist a partial snapshot marked `budget_exhausted`.
  Partial snapshots never pass a release gate.

Reports and the TUI show the configured cap, projected cost, actual cost,
remaining budget, cache reuse, and any cases skipped because of the rail.

## Product surfaces

The machine-readable benchmark snapshot owns observed metrics, thresholds,
gate outcomes, and evidence references. The report and TUI render the same gate
IDs as `pass`, `fail`, `review`, or `unavailable`; they do not recompute policy.
Remediation proof reuses the baseline and post-fix snapshots, so a proposed fix
cannot redefine the gate that judged it.

## Local evidence

The current skill already uses a `0.90` quality floor, authoritative replay
cost, explicit high-risk abstention, deterministic-first evaluation, and
position-swapped judging. The current evaluator's three- and five-example
confidence constants are bootstrap behavior, not release-grade calibration;
the v1 defaults above replace them when the benchmark contracts are implemented.
