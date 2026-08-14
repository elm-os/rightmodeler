# Operating the evidence contract

Use this guide when reading a verdict or deciding whether a model substitution has enough proof.
The values and identifiers below come from the TypeScript kernel and the active Phase A pipeline
policy. Do not replace a lower bound with a point estimate or silently reinterpret a count's unit.

## Evidence ladder

Choose the strongest applicable signal in this order:

1. Deterministic verification: tests, schemas, typed tool checks, or another executable oracle.
2. Reference comparison against the accepted output for the same case.
3. Trajectory evaluation across calls, tools, state, and the terminal result.
4. Calibrated LLM judge for behavior that the earlier rungs cannot decide.
5. Abstain when the evidence is insufficient.

Only promote a check to deterministic evidence after a mutation test proves that corrupting the
output makes the check fail. The kernel keeps evaluator kinds as separate estimands, requires the
predeclared case/stratum/evaluator matrix to be complete, and binds the decision to the weakest
worst-case bound. Evidence from one evaluator kind cannot fill missing trials or diversity for
another.

Prefer a configured external evaluator when it is reachable. Otherwise the pipeline warns and
uses the built-in judge. That is provider precedence within an evaluation rung, not permission to
skip stronger deterministic or trajectory evidence.

## Minimums and units

- `MIN_REVIEW_TRIALS = 10`: included, assessed executions **per evaluator kind**.
- `MIN_DISTINCT_STEPS = 2`: distinct `stepId` values **per evaluator kind**.
- `MIN_DISTINCT_TRAJECTORIES = 5`: distinct `trajectoryId` values **per evaluator kind**.
- `EXCLUDED_FRACTION_MAX = 0.05`: maximum excluded fraction per evaluator kind; exactly 5% passes,
  while anything greater abstains.
- `DEFAULT_PASS_FRACTION = 0.75`: raw pass-rate shortlist filter for every evaluator kind. This is
  not the release gate.
- Statistical intervals default to 95% confidence. Repeated cases from a trajectory use a
  trajectory-cluster bootstrap; otherwise the kernel uses Wilson intervals.

The release policy accepts a quality floor only in `(0.8, 1.0]` and an availability floor only in
`(0, 1.0]`. The active Phase A policy is `phase-a-v2`, with a worst-case quality lower-bound floor
of `0.85` and an availability lower-bound floor of `0.70`. These are fractions, not percentages.

## Abstention reasons

The exported `ABSTAIN_REASONS` values are:

- `insufficient_availability`: the availability lower bound is below the configured floor.
- `excluded_fraction_exceeded`: the largest per-kind excluded fraction is greater than `0.05`.
- `insufficient_review_trials`: a kind has fewer than 10 included assessed executions.
- `insufficient_distinct_steps`: a kind covers fewer than 2 distinct step IDs.
- `insufficient_distinct_trajectories`: a kind covers fewer than 5 distinct trajectory IDs.
- `missing_deterministic_evidence`: a family marked as requiring deterministic evidence has none;
  the recorded observed/required pair is `0/1`.
- `required_abstention`: fewer required-abstention executions abstained than were required.
- `incomplete_evidence_coverage`: covered executions do not equal all executions.
- `incomplete_evaluator_coverage`: the observed assignment matrix differs from the predeclared
  case/stratum/evaluator matrix, including duplicates or unexpected cells.
- `cascade_isolated`: confirmation isolated a nonempty culprit set. Operationally this produces
  `reject`, even though the reason is part of the exported reason enum.
- `cascade_inconclusive`: confirmation could not resolve the cascade and produces `abstain`.
- `selection_candidate_verdict_missing`: a candidate in the swap set reached selection with no
  shortlist verdict recorded for it.
- `selection_missing_shortlist_verdicts`: the family reached selection with no shortlist-split
  verdicts at all, so no winner can be chosen.
- `replay_operational_block`: replay could not run for the family for an operational reason,
  such as an exhausted budget lease or a blocked provider; the block is recorded, not scored.
- `provider_catalog_drift`: the provider catalog no longer carries a model the evidence
  depends on, so the family cannot be priced or replayed as recorded.
- `confirmation_model_metadata_missing`: confirmation needed model metadata that the recorded
  evidence does not carry.
- `confirmation_recorded_content_missing`: confirmation needed recorded case content that is
  absent from the store.

Cascade decisions take precedence. Otherwise the kernel chooses the first applicable reason in
this order: review trials, distinct steps, distinct trajectories, deterministic evidence,
required abstentions, evidence coverage, evaluator coverage, availability, excluded fraction.
Report the selected reason plus its observed and required values; do not substitute a friendlier
reason later in the list.

The exported `EVIDENCE_EXCLUSION_REASONS` values name malformed or absent execution evidence:

- `assessment_evidence_missing`: an attributable non-judge execution has no assessment and no
  more specific named absence.
- `judge_evidence_incomplete`: judge evidence is absent or its assessment lacks the required
  position-swap consistency metadata.

These executions stay in the worst-case denominator but are excluded from the conditional-quality
numerator and denominator. They count toward the excluded-fraction ceiling; if too few complete
trials remain, the family abstains under the applicable evidence minimum.

An attempt with non-empty output but missing or zero output-token usage records
`usage.status = "usage_unreported"`. Its token usage and catalog-price cost are estimates, so
`costIsEstimate` is true. The execution remains attributable and included; this state is not an
evidence exclusion.

## Release gate IDs

- `zero-unsafe-substitutions`: the total unsafe-substitution count must be zero.
- `quality`: at least one verdict must exist, and every evaluator kind's worst-case-imputed lower
  bound must meet the configured quality floor.
- `evidence-coverage`: at least one execution must exist, and every execution must have evidence.
- `required-abstention`: satisfied required abstentions must equal required abstentions. `0/0`
  passes.
- `availability`: at least one verdict must exist, and every verdict's availability lower bound
  must meet the configured floor.

All release gates bind. A candidate clearing the `0.75` shortlist pass fraction is not a release
recommendation. Selection also requires the held-out winner's multiplicity-corrected 95% lower
bound to meet the quality floor.

## Judge selection and execution

Candidate and reference families must both be known. Exclude a judge catalog entry when its
family is missing, `unknown`, the candidate family, or the reference family; when its declared
type is not `language`; or when declared output modalities omit text. With no eligible neutral
family, fail with no judge rather than borrowing either evaluated family.

Rank eligible judges by the sum of equal-weight percentile signals for release/creation recency,
context length, and prompt-plus-completion price. Missing signals score zero. Break equal sums by
higher raw recency, then context, then price, then lexicographically larger model ID. Malformed or
non-finite numeric catalog signals fail loudly. Preserve the full strongest-first ranking for
run-level fallback.

The judge runs two temperature-zero calls with reference and candidate positions swapped. It must
return exactly `verdict`, `score`, and `justification` as strict JSON. Send a strict
`response_format` JSON schema when the selected catalog entry advertises structured output;
otherwise append an explicit strict-JSON-only instruction and omit `response_format`. Before the
unchanged exact schema validation, extraction may remove one surrounding Markdown code fence and
leading prose before the first balanced JSON object. Invalid or incomplete JSON still fails.

Kernel scores, not the judge's numeric score, bind: `equivalent = 1`, `minor_drift = 0.6`, and
`divergent = 0`. Only two `equivalent` verdicts pass. A position disagreement becomes
`minor_drift`, fails, and records `orderConsistent: false`. After three consecutive
`response_malformed` assessments, mark that model unusable with a warning and a zero-cost
`SpendEvent` note, switch to the next-ranked eligible model, and re-judge only the affected pending
cells. Try at most two judge models. The replay driver publishes the terminal execution only after
complete judge evidence is persisted or both judges are exhausted, so an interrupted pending cell
is retried rather than resumed as complete.

## Reading the final result

Check, in order: terminal family state; abstention or cascade reason; evaluator assignment
coverage; minimum counts with units; excluded and unavailable cases; weakest worst-case lower
bound; all five gate results; and held-out selection-adjusted lower bound. Preserve excluded
cases as failures in the worst-case bound. Never report quality only among successful responses
without the separate availability gate.
