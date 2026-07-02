# Cheaper Models Recommendation Report PRD

## 1. Summary

Engineering teams often default to frontier AI models for agentic or LLM-powered workflows because they do not have reliable evidence that cheaper models can complete their specific tasks. This product generates a recommendation report from historical agent/model runs, identifying where cheaper models can replace expensive frontier models while preserving task quality.

The first product is a report, not a runtime gateway. It proves value using the team's own historical data before asking them to route live traffic through a new system.

## 2. Target User

Primary user:

- Team lead or engineering manager responsible for AI model quality, reliability, and spend.

Secondary users:

- Developers who provide logs, prompts, task outputs, and acceptance signals.
- AI platform or infrastructure engineers who may later implement model routing based on the report.

## 3. Problem

Teams lack a trustworthy way to answer:

- Which tasks actually require frontier models?
- Which cheaper models can handle specific task families?
- How much money can we save without materially reducing task success?
- What evidence supports each model substitution?

Generic public benchmarks are insufficient because they do not reflect the team's actual prompts, tools, success criteria, data distribution, or workflows.

## 4. Product Goal

Generate an evidence-backed report that recommends cheaper model substitutions by task family.

Example recommendation:

> For PR summary tasks, replace Model A with Model B. Estimated cost reduction: 72%. Confidence: medium. Evidence: 18 historical runs, 12 reference comparisons, 6 LLM-judge evaluations, no deterministic checks available.

## 5. Non-Goals

MVP will not:

- Route production traffic.
- Act as a live AI gateway.
- Fine-tune models.
- Guarantee correctness for safety-critical tasks.
- Replace human review for high-risk recommendations.
- Depend only on public benchmarks.

Future versions may include a model gateway/router once teams trust the recommendation methodology.

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
3. Infer task families from the data.
4. Select the strongest available evaluation method for each task family.
5. Replay or re-run representative tasks across candidate cheaper models.
6. Score candidate models against task-specific success criteria.
7. Estimate cost savings.
8. Generate a recommendation report with confidence, evidence type, and caveats.

## 8. Task Family Detection

The framework should invent task family labels automatically.

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

The framework must not treat LLM-as-judge as the default evaluator. It should choose the strongest available evaluator per task family.

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
- Tool calls are valid.
- API calls follow constraints.
- No runtime errors.
- Latency and retry counts are within threshold.

This evidence type should produce the highest-confidence recommendations.

### 9.2 Reference-Based Comparison

If a historical output was accepted, compare candidate model outputs against:

- Original prompt.
- System prompt.
- Accepted output.
- Human notes, if available.

This is stronger than asking an LLM judge whether an output is good in isolation.

### 9.3 Agent Trajectory Evaluation

For agent logs, evaluate more than the final output.

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
- Latency.
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
- Automatic task family inference.
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

- Runtime AI gateway/router.
- Policy-based routing by task family.
- Continuous eval monitoring.
- Regression alerts when cheaper model quality drops.
- Human review workflow for approving task families and recommendations.
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
