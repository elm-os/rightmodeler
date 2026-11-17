# Product Requirements: Validated Swaps to Cheaper or Newer Models

Sections 1 to 5 follow [positioning.md](positioning.md). The requirements from section 6 on were
written before the TypeScript harness; where they and `harness/docs/Architecture.md` disagree,
Architecture.md is the design of record.

## 1. Summary

We think the biggest bottleneck in maintaining software is the human in the loop: not the
judgment, the work. We are solving it first for production AI systems.

The first product is a validation framework for model swaps. It validates swaps to cheaper or newer
models on your production traces and opens each one that clears every release gate as a draft pull
request that changes only model identifiers, with the evidence attached. rightmodeler takes the
work out of the loop, not the judgment: today, the final yes stays yours.

The direction is autonomous self-maintenance and optimization of production AI systems, reached
one validated change at a time.

## 2. Target User

Primary user:

- The engineer or team lead who owns a production AI system and answers for its model quality,
  reliability and spend.

Secondary users:

- Developers whose app already records its model calls, and who review the draft pull requests.
- Platform engineers who run the CLI in CI or self-host the agent.

## 3. Problem

For a production AI system, a new model ships every few weeks, and each one restarts the same
manual job: notice it, pull real traces, build a replay, grade the outputs, write it up so it
survives review, migrate, and do it again. That work, not the final call, is the bottleneck, and
few teams can staff it. The shortcuts teams take instead do not hold up:

1. **Blind swaps fail quietly.** A cheaper model drops into a step in thirty seconds. When it
   fails, nothing throws: the JSON still parses and is wrong on the edge cases.
2. **Routers don't work in production.** Our opinion, for three reasons: a runtime router picks a
   model per request with a policy that was not validated on your workload; it adds a hop and a
   dependency to the request path; and the same input can take different models, so behavior is
   harder to reproduce, audit and roll back. A gateway that serves the model you pin is a
   different thing.
3. **General benchmarks aren't your workload.** A leaderboard ranks models on someone else's
   tasks. It cannot tell you whether a cheaper model matches the outputs you already accepted.
4. **Frontier everywhere costs too much.** The most expensive model on every step feels safe
   until the bill compounds, call by call, on steps nobody has measured.

What holds up: one pinned model per step, validated on your own traces and changed through code
review.

## 4. Product Goal

Take the work out of the loop, not the judgment, and earn each step of autonomy with evidence,
starting with validated swaps to cheaper or newer models.

The rightmodeler CLI reads the model calls your app already recorded, replays the recorded steps
on cheaper or newer candidate models from your provider's live catalog, and has a judge from a
different vendor, or your own evaluator, grade every answer against the output you accepted. Replay
sends recorded text conversations: cases whose conversation carries tool calls, tool definitions or
non-text parts are left out of the replay sample today, and the run says how many. A swap that
clears every release gate becomes a draft pull request that changes only model identifiers, with
the evidence attached.

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces:
agreement with the outputs you accepted, at a statistical lower bound that reaches your quality
floor on held-out cases, with swaps that feed later model steps confirmed end to end in a
sandbox. rightmodeler measures agreement with what you shipped, not ground-truth
correctness, and abstains when the evidence is thin.

The rightmodeler agent, self-hosted today, runs the maintenance loop on a schedule: a weekly
catalog and price check that flags cheaper new or repriced models, a daily drift check on new
traces whose proposals a person approves, one regression replay for each merged swap set, and
follow-up on swap pull requests as review and CI report back. On your word it replays new
candidates; once a replay clears every gate, it opens the draft pull request. It never merges.

A person still sets the policy (the quality floor, which models are allowed, an optional spend
cap), gives the agent the word before it replays a new candidate, and merges the swaps they
accept. Rolling back is one command that opens another pull request. That is deliberate:
autonomy is earned with evidence, and validation is how rightmodeler earns it. The direction is a
system that maintains itself inside the policy you set.

Illustrative example:

> For the PR summary step, a draft pull request that changes Model A to the cheaper Model B and
> nothing else. Its body carries the evidence: the decision, the evaluator kinds, the cascade
> check, the worst-case lower bound that cleared the quality floor, the cost per replayed case for
> both models, the caps and the case IDs.

## 5. Non-Goals

rightmodeler does not:

- Route traffic or produce a routing policy. It validates one pinned model per step, offline,
  before a person merges, and never sits in the request path.
- Run on, watch or shadow live production traffic. It validates on the calls your app already
  recorded and runs end-to-end confirmation in a sandbox, apart from your production deployment.
  The sandbox keeps your model key out but has ordinary network access, so your app's tools should
  point at test fixtures, not production services.
- Claim ground-truth correctness or guarantee quality. It measures agreement with the outputs you
  accepted.
- Fine-tune models.
- Treat general benchmarks or public leaderboards as evidence about your workload.

Not in scope today:

- Merging, deploying or swapping a model on its own. Only a person merges.
- Validating newer models that do not cost less than the recorded model; support ships in a later
  release. Candidates must cost less than the recorded model, even when named with `--candidate`.
- Tuning reasoning effort, prompts or retries.
- Ranking candidates on your own token mix, measuring savings after merge, latency budgets, or
  latency comparisons with the current model.

## 6. Inputs

The system accepts a bundle of historical model or agent runs.

Required where available:

- Original prompt.
- System prompt.
- Tool-call transcript or final output.
- Model used.
- Token usage and cost.
- Success or failure signal.
- Optional human notes describing what counted as good.

Input quality varies by customer, so the framework must make best use of available data and mark confidence accordingly.

## 7. Core Workflow

1. Ingest historical runs.
2. Normalize prompts, outputs, tool calls, model metadata, costs, and success signals.
3. Group call sites into families from the scanner's call-site identity.
4. Select the strongest available evaluation method for each task family.
5. Replay or re-run representative tasks across candidate cheaper models.
6. Score candidate models against task-specific success criteria.
7. Estimate cost savings.
8. Generate a recommendation report with confidence, evidence type, and caveats.

## 8. Task Family Detection

The original framework assigned task family labels with the first matching rule in
`skills/rightmodeler/scripts/analyze.py` (retired; replaced by the TypeScript harness, see
`harness/docs/Architecture.md`). It used eight hard-coded regular expressions
for `pr_summary`, `test_generation`, `bug_fix`, `sql_generation`, `code_review`,
`doc_rewrite`, `support_draft`, and `tool_agent`, followed by a `general` catch-all.
There is no override at any layer. Automatic data-driven label inference is future scope.

Examples:

- PR summary.
- Unit test generation.
- Bug fix suggestion.
- SQL generation.
- Customer support draft.
- Documentation rewrite.
- Code review comment.
- Tool-using support agent workflow.

Each task family should include:

- Label.
- Description.
- Representative examples.
- Number of historical runs.
- Current model usage.
- Cost profile.
- Available success signals.
- Evaluation method selected.

## 9. Evaluation Methodology

The framework must not treat LLM-as-judge as the default evaluator. It should choose the strongest available evaluator per task family (superseded: with no evaluator configured, a judge from a different vendor grades each answer against the accepted output in both answer orders, and a configured evaluator replaces it; see `harness/docs/Architecture.md` sections 10 and 13).

Evaluation priority:

1. Deterministic verifier.
2. Reference-based comparison.
3. Agent trajectory and tool-use evaluation.
4. Calibrated LLM-as-judge.
5. Abstain or low-confidence recommendation.

### 9.1 Deterministic Verifier

Use task-native checks when possible.

Examples:

- Unit tests pass.
- Build succeeds.
- Typecheck succeeds.
- Lint succeeds.
- JSON schema is valid.
- Required fields are present.
- Tool calls are valid (superseded: see 9.3).
- API calls follow constraints.
- No runtime errors.
- Latency and retry counts are within threshold (superseded: no release gate covers latency or retries, and the evidence reports only the winning candidate's p50 latency; see `harness/docs/Architecture.md` section 18).

This evidence type should produce the highest-confidence recommendations.

### 9.2 Reference-Based Comparison

If a historical output was accepted, compare candidate model outputs against:

- Original prompt.
- System prompt.
- Accepted output.
- Human notes, if available.

This is stronger than asking an LLM judge whether an output is good in isolation.

### 9.3 Agent Trajectory Evaluation

For agent logs, evaluate more than the final output (superseded: replay resends each recorded conversation as text; a case whose conversation carries tool calls, tool definitions or non-text parts, or that comes from a call site that needs tools or structured output, is left out of the replay sample, and Mode B confirmation judges only the app's final output; see `harness/packages/rightmodeler/docs/getting-started.md`).

Signals may include:

- Correct tool selection.
- Correct tool arguments.
- Constraint adherence.
- Avoidance of loops.
- Recovery from tool errors.
- Number of steps.
- Completion status.
- Whether the final answer reflects tool results.

### 9.4 Calibrated LLM-as-Judge

Use LLM judging only where stronger signals are unavailable or insufficient, especially for fuzzy outputs such as:

- Summaries.
- Explanations.
- Drafts.
- Plans.
- Design critiques.
- Support responses.

Required safeguards:

- Prefer reference-guided judging when accepted outputs exist.
- Use pairwise comparisons where useful.
- Swap output order to reduce position bias.
- Use multiple judges or repeated runs for important decisions.
- Calibrate against available human labels.
- Report low confidence when no calibration exists.

### 9.5 Abstain

The system should abstain from strong recommendations when evidence is weak.

Example:

> No substitution recommended for auth-related code edits. Available data is sparse, task family is high risk, and success criteria are not deterministic.

## 10. Candidate Model Selection

The system should test multiple cheaper models against each task family.

Candidate selection factors:

- Cost per input/output token.
- Context window.
- Tool-use support.
- Structured output support.
- Latency (superseded: the shortlist filters on capability, price and release date, never on latency; see `harness/docs/Architecture.md` section 4).
- Provider availability.
- Customer allowlist or vendor constraints.
- Historical model used.

The MVP may start with a configurable model list supplied by the user.

## 11. Report Output

The report should be useful to an engineering manager without requiring them to inspect raw eval traces.

Required sections:

- Executive summary.
- Total estimated savings.
- Recommended model substitutions.
- Task families discovered.
- Evaluation methodology by task family.
- Confidence levels.
- Evidence breakdown.
- Cost analysis.
- Risk flags.
- Cases where no cheaper model is recommended.
- Appendix with representative examples and eval details.

Each recommendation must include:

- Task family.
- Current model.
- Recommended cheaper model.
- Estimated cost reduction.
- Quality score or pass rate.
- Confidence.
- Evidence type.
- Number of examples evaluated.
- Main risks.
- Suggested rollout plan.

## 12. Confidence Scoring

Superseded: the harness has no confidence bands, and this note covers every mention of
confidence in this document. The shortlist half only screens candidates; a swap clears only when
its 95% statistical lower bound on held-out cases, adjusted for the number of candidates, reaches
the quality floor, and the harness abstains with a named reason when the evidence is thin. See
`harness/docs/Architecture.md` section 7.

Confidence should be derived from:

- Number of historical examples.
- Strength of evaluator.
- Agreement across evaluators.
- Availability of human labels.
- Task risk level.
- Variance across candidate model outputs.
- Difference in quality between current and recommended model.

Suggested confidence bands:

- High: deterministic or strongly reference-backed evidence across enough examples.
- Medium: reference-backed or calibrated judge evidence with moderate sample size.
- Low: sparse data, fuzzy judging, weak calibration, or high task variance.
- Abstain: evidence insufficient or task risk too high.

## 13. MVP Scope

MVP must support:

- Upload or local ingestion of historical run bundles.
- Schema normalization for prompts, outputs, tool calls, model, tokens, cost, and success signals.
- Configurable candidate model list.
- Cost calculation.
- At least three evaluator types:
  - Deterministic/schema checks.
  - Reference-based comparison.
  - LLM-as-judge with safeguards.
- Static recommendation report.
- Evidence breakdown for every recommendation.

## 14. Future Scope

Possible follow-on products:

- Runtime AI gateway/router (dropped: rightmodeler validates one pinned model per step, offline,
  before a person merges, and never sits in the request path; see [positioning.md](positioning.md)).
- Policy-based routing by task family (dropped: rightmodeler produces no routing policy, only
  draft pull requests that change model identifiers).
- Continuous eval monitoring.
- Regression alerts when cheaper model quality drops.
- Human review workflow for approving task families and recommendations (superseded: decision 7
  in `harness/docs/plan.md` puts the review on the draft pull request, and
  `harness/docs/Architecture.md` section 16 records that there is no interactive approval TUI).
- Automatic data-driven task family inference and label overrides.
- Integration with LangSmith, Braintrust, OpenAI Evals, Phoenix, or internal tracing systems.
- Provider price syncing.
- Team-level dashboards.

## 15. Success Metrics

Product success:

- Percentage of task families with actionable recommendations.
- Estimated monthly cost savings identified.
- Human acceptance rate of recommendations.
- Post-rollout quality regression rate.
- Time from log upload to report.
- Number of recommendations with high or medium confidence.

Evaluation quality:

- Agreement with human review.
- False substitution rate.
- Abstain rate on weak evidence.
- Reproducibility across repeated eval runs.

## 16. Risks

Major risks:

- Poor task family clustering leads to unsafe recommendations.
- LLM-as-judge produces biased or overconfident results.
- Historical logs lack success signals.
- Candidate model outputs are evaluated against flawed accepted outputs.
- Cost savings are overstated due to missing tool, retry, or latency costs.
- Engineering managers distrust black-box recommendations.

Mitigations:

- Show evidence type and confidence for every recommendation.
- Preserve representative examples.
- Prefer deterministic checks where possible.
- Use abstain behavior.
- Calibrate judges against human labels where available.
- Report methodology limitations clearly.

## 17. Open Questions

- What historical log formats should be supported first?
- Should users be able to edit task family labels before final report generation?
- Which model providers should be included in the initial candidate set?
- How many examples are required before a recommendation can be medium or high confidence?
- Should high-risk task families require explicit human approval?
- Should public benchmarks be used only as supplemental context or as priors in candidate model selection?

## 18. Research References

- SWE-bench: harness-based software engineering evaluation and verified task subsets: https://www.swebench.com/
- Best practices for rigorous agentic benchmarks: https://arxiv.org/html/2507.02825v5
- LLM-as-a-judge survey: https://arxiv.org/html/2411.15594v6
- Position bias in LLM-as-a-judge systems: https://aclanthology.org/2025.ijcnlp-long.18.pdf
- Reference-guided multi-judge evaluation for free-form QA: https://aclanthology.org/2025.winlp-main.37.pdf
- Rabanser, Kapoor, Kirgis, Liu, Utpala, and Narayanan. "Towards a Science of AI Agent Reliability." ICML 2026. arXiv:2602.16666.
- Boyeau, Angelopoulos, Li, Yosef, Malik, and Jordan. "AutoEval Done Right: Using Synthetic Data for Model Evaluation." ICML 2025, PMLR 267:5276-5290. arXiv:2403.07008.
- Sinha, Arun, Goel, Staab, and Geiping. "The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs." ICLR 2026. arXiv:2509.09677.
- Gui, Jin, and Ren. "Conformal Alignment: Knowing When to Trust Foundation Models with Guarantees." NeurIPS 2024. arXiv:2405.10301.
- Wu, Nair, and Candes. "Efficient Evaluation of LLM Performance with Statistical Guarantees." arXiv preprint, 2026. arXiv:2601.20251.

Do not repeat two corrected claims from earlier research drafts:

- The roughly 50% effective-sample-size improvement applies only to experiments with non-LLM autoraters. With an LLM autorater, the reported improvement is 20-25%.
- Horizon growth in step accuracy is hyperbolic, not exponential. The paper uses exponential growth only for horizon over calendar time.
