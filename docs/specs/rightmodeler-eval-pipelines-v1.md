# Rightmodeler Eval Pipelines V1

- Status: `implemented`
- Scope: local product implementation with stable Crucible artifact seams
- Source: local Wayfinder planning map under `tasks/wayfinder/`
- Implementation tracker: local `tasks/implementation-tickets.md`

## Problem Statement

Teams can inspect historical agent traces and estimate model cost, but they do
not have a reliable local system for proving that a cheaper model preserves
quality and speed across real task families. Existing analysis can identify
possible substitutions, but it does not yet evaluate the full
`detect -> prove -> fix` loop, distinguish strong evidence from weak evidence,
measure recommendation accuracy, or turn benchmark failures into safe,
auditable remediation artifacts.

The product must go beyond observability. When rightmodeler finds a bad
recommendation, missed downgrade, weak confidence call, replay defect, or
repository issue, it must classify the cause and propose the next action. Any
proposed fix must be proven against frozen evidence before the user may apply
it. The local workflow must remain offline by default, must not mutate a
working tree without an explicit action, and must never create remote state.

The same machine-readable evidence must support a future managed Crucible
experience without creating a second evaluator implementation or requiring
customers to route live model traffic through rightmodeler.

## Solution

Build one artifact-first evaluation engine behind the existing Python pipeline
command boundary. The engine will turn accepted historical traces into
versioned benchmark cases, evaluate imported or explicitly replayed candidate
results, and emit immutable benchmark snapshots containing quality, speed,
cost, confidence, evidence, and release-gate outcomes.

The engine will route workloads through four reusable evaluation families:
`reference-freeform`, `structured-check`, `tool-trajectory`, and `repo-fix`.
It will prefer deterministic verification, then reference and trajectory
evidence, then calibrated judging, and finally abstention.

Failed or weak outcomes will produce one primary remediation issue class and
one next action. Where a fix can be validated locally, rightmodeler will create
an immutable remediation evidence bundle with before-and-after snapshots,
validation results, a proposed diff, and rollback data. Generation and approval
will not change the repository. A separate explicit `apply` action will perform
a guarded local change, and an explicit `rollback` action will safely reverse
it when the working tree still matches the recorded state.

Customer benchmark corpora will remain customer-owned and immutable by
version. Locally, project maintainers approve corpus changes. Crucible may
become the managed source of truth for workflow state, reviewers, approvals,
audit history, and delivery while consuming the same content-addressed evidence
produced by the local engine.

## User Stories

1. As an engineering manager, I want recommendations scored against my team's own accepted runs, so that model substitutions reflect our real workload.
2. As an engineering manager, I want quality, speed, cost, coverage, and confidence reported separately, so that one favorable metric cannot hide another regression.
3. As an engineering manager, I want abstentions shown separately from correct recommendations, so that low coverage cannot appear as high accuracy.
4. As an engineer, I want to import candidate outputs generated elsewhere, so that I can benchmark them without making new model calls.
5. As an engineer, I want optional candidate replay through rightmodeler, so that I can obtain higher-fidelity evidence when imported results are insufficient.
6. As an engineer, I want replay disabled by default, so that ordinary checks stay offline and free of provider spend.
7. As an engineer, I want every replay run bounded by an explicit cost cap, so that evaluation cannot spend money unexpectedly.
8. As an engineer, I want partial results preserved when a replay budget is exhausted, so that completed work remains inspectable without being mistaken for a passing release gate.
9. As an engineer, I want structured outputs verified by machine-checkable rules, so that schema failures are not delegated to a prose judge.
10. As an engineer, I want freeform outputs compared with accepted references or frozen human verdicts, so that semantic quality is grounded in reviewed evidence.
11. As an engineer, I want tool-using agents evaluated on tool selection, arguments, loops, retries, recovery, and final state, so that acceptable final prose cannot hide a broken trajectory.
12. As an engineer, I want repository fixes validated through declared local commands in isolation, so that a patch is not called correct merely because it looks plausible.
13. As an engineer, I want workloads to retain familiar labels while evaluation routes through reusable pipeline families, so that reports remain understandable without duplicating evaluator logic.
14. As an engineer, I want missing timing reported as unavailable, so that rightmodeler never fabricates speed claims from incomplete traces.
15. As an engineer, I want paired candidate and baseline timing, so that speed comparisons use the same cases and environment.
16. As an engineer, I want every recommendation to include its evaluator, sample count, evidence references, confidence, risks, and gate outcomes, so that I can audit why it exists.
17. As an engineer, I want high-risk or weak-evidence cases to abstain, so that cost savings do not override safety.
18. As a product maintainer, I want a frozen conformance corpus with labeled safe opportunities and unsafe cases, so that rightmodeler releases can be evaluated consistently.
19. As a product maintainer, I want zero unsafe recommendations as a hard release gate, so that regressions fail before release.
20. As a product maintainer, I want confidence derived from evidence strength and sample size, so that confidence labels have consistent meaning.
21. As a product maintainer, I want reports and interactive views to render gate outcomes from the benchmark snapshot, so that product surfaces cannot recompute conflicting policy.
22. As an engineer, I want every failed benchmark outcome classified into one primary issue class, so that I receive an actionable diagnosis rather than a list of guesses.
23. As an engineer, I want parser and normalizer defects to produce targeted fix proposals with affected trace fixtures, so that ingestion failures can be corrected and proven.
24. As an engineer, I want evaluator defects to produce rubric, check, or configuration proposals with case evidence, so that scoring errors can be repaired safely.
25. As an engineer, I want replay defects to produce replay-policy proposals and rerun evidence, so that fidelity problems are distinguished from model failures.
26. As an engineer, I want candidate-selection defects to produce revised filters or shortlist policy, so that missed safe downgrades can be recovered.
27. As an engineer, I want ambiguous causes to become review items or abstentions, so that rightmodeler does not generate unsupported patches.
28. As an engineer, I want a proposed remediation to include frozen before-and-after benchmark snapshots, so that I can see whether it fixed the measured issue.
29. As an engineer, I want remediation proof to include untouched holdout results when available, so that fixes cannot overfit visible examples.
30. As an engineer, I want remediation generation and approval to leave my working tree unchanged, so that reviewing evidence is safe.
31. As an engineer, I want an explicit guarded apply action, so that rightmodeler acts only after I approve a proven fix.
32. As an engineer, I want apply to refuse stale bundles or changed repository state, so that old evidence cannot authorize a new mutation.
33. As an engineer, I want failed post-apply validation to restore the known pre-apply state when safe, so that an unsuccessful fix does not remain silently applied.
34. As an engineer, I want an explicit rollback action with stored reverse evidence, so that I can safely undo an applied remediation.
35. As an engineer, I want rollback to refuse when later edits overlap the remediation, so that newer work is never overwritten.
36. As a local project owner, I want to approve which traces and labels become golden cases, so that the benchmark remains owned by my project.
37. As a local project owner, I want every corpus change to create a new immutable version, so that historical scorecards remain reproducible.
38. As a local project owner, I want working cases separated from protected holdouts, so that remediation cannot train on its own proof set.
39. As a local project owner, I want exposed holdouts replaced in a new corpus version, so that leaked labels do not remain trusted unseen evidence.
40. As a local project owner, I want drift detection to propose additions, relabels, retirements, or red-team cases, so that the corpus evolves with real workload changes.
41. As a local project owner, I want drift proposals to require approval, so that automated detection cannot silently rewrite benchmark truth.
42. As a Crucible workspace owner, I want Crucible to manage reviewers, approvals, assignments, comments, and audit history, so that team workflow has a durable managed source of truth.
43. As a Crucible workspace owner, I want local evidence imported by content digest, so that managed workflow refers to exactly the artifact that was proven locally.
44. As a Crucible workspace owner, I want future branch, commit, and pull-request delivery to use the same remediation evidence, so that hosted benefits do not create an incompatible evaluation path.

## Implementation Decisions

- The Python pipeline command is the single evaluation engine boundary. The installed skill orchestrates it, and Crucible consumes its contracts rather than implementing separate evaluation logic.
- The first product implementation is local and artifact-first. Live traffic routing and runtime model gateway behavior are excluded.
- The primary scoring unit is the task family. Step-level diagnosis and fix-artifact quality are subordinate views used for replay, attribution, and remediation.
- User-facing workload labels remain metadata. Evaluator routing uses `reference-freeform`, `structured-check`, `tool-trajectory`, and `repo-fix`.
- The existing historical-run, normalized-trace, pipeline-analysis, task-family, and recommendation artifacts remain valid inputs or outputs. The implementation must not introduce a second normalized trace format.
- The shared contract package gains versioned schemas for benchmark cases, candidate-result bundles, benchmark snapshots, corpus manifests, remediation evidence manifests, and lifecycle events.
- Contract schemas are strict at stable boundaries, versioned explicitly, and validated before downstream processing. Content-addressed artifacts use canonical serialization before digest calculation.
- A benchmark case references accepted trace evidence rather than copying an untracked alternate trace representation. It declares its evaluation family, required checks, risk, reference evidence, and required evidence level.
- Candidate-result bundles normalize both imported and replay-generated results into one shape. They carry output, model identity, cost, timing, optional trajectory, optional diff, and local validation results.
- Benchmark snapshots are immutable. They own per-case verdicts, aggregate scorecards, thresholds, gate outcomes, abstentions, timing availability, evaluation cost, and evidence references.
- Reports, interactive views, remediation, and Crucible render policy from benchmark snapshots. They do not independently recompute confidence or release gates.
- Evaluation order is deterministic verification, reference comparison, trajectory evaluation, calibrated LLM judging, then abstain.
- `reference-freeform` requires a supplied frozen human verdict or a sufficiently calibrated evaluator. Accepted prose alone does not create deterministic semantic truth.
- `structured-check` uses parsing, schema validation, and configured contract checks.
- `tool-trajectory` evaluates tool name, arguments, order, retries, recovery, loops, terminal state, and whether the final answer reflects tool results.
- `repo-fix` evaluates patch scope and declared local validation commands inside an isolated worktree.
- Replay is explicit and outside default CI. Single-shot replay is allowed only for isolated model steps. Tool, loop, and downstream-dependent cases require sandboxed end-to-end replay.
- Provider-backed replay requires an explicit maximum cost, a bounded worst-case estimate, authoritative actual cost recording, stable cache keys, and budget-aware partial snapshots.
- The v1 quality floor is `0.90`. Release policy requires zero unsafe substitutions, at least `95%` recommendation precision, at least `80%` recall of labeled safe downgrade opportunities, `100%` required high-risk or insufficient-evidence abstention, and complete terminal verdict coverage.
- High confidence requires strong deterministic evidence across at least 20 cases or strong reference or trajectory evidence across at least 30 cases, at least `0.95` pass rate, no hard failure, and required evaluator agreement.
- Medium confidence requires eligible deterministic, reference, or trajectory evidence across at least 10 cases and at least `0.90` pass rate with no hard failure.
- Judge evidence may support medium confidence only after the agreed human-label calibration and agreement thresholds are satisfied. Judge evidence alone cannot produce high confidence in v1.
- Speed uses paired p50 and p95 wall-clock measurements. Missing timing is unavailable. A faster claim requires at least `10%` paired median improvement without p95 regression, and a candidate has no material speed regression when p95 is no more than `20%` slower.
- Offline smoke and imported-result benchmarks have zero external-spend budget. Default checks validate contracts, deterministic fixtures, report generation, repeatability, and absence of network calls.
- Each failed, missed, or weak result has exactly one primary issue class: `ingestion`, `evaluator`, `replay`, `candidate-selection`, `repo-validation`, or `insufficient-evidence`.
- Draftable fixes carry a frozen baseline, triggering cases, primary diagnosis, proposed diff or configuration change, validation commands, post-fix snapshot, holdout result when available, and residual risks.
- A remediation is proven only when the target improves, relevant deterministic checks remain stable, and the available holdout still passes. Otherwise it remains a draft or review item.
- Local remediation records separate immutable, content-addressed evidence from append-only lifecycle events. Approval records actor, timestamp, decision, optional reason, repository base revision, and evidence digest.
- Generating, approving, rejecting, or holding a remediation does not change the working tree.
- Apply is explicit and local. It validates approval, evidence digest, repository base revision, affected-file digests, and patch applicability. V1 has no force bypass and creates no commit, branch, push, pull request, or remote action.
- Post-apply validation is mandatory. A failed application records failure and restores the known pre-apply state when safe.
- Rollback is explicit and uses stored reverse evidence. It proceeds only when affected files still match the recorded applied state; otherwise it refuses and presents the reverse diff for manual resolution.
- Customer corpora are customer-owned. Local maintainers approve golden cases. Crucible workspace policy controls managed reviewers and approval, while rightmodeler maintainers own only the product conformance corpus.
- Corpus versions are immutable and content-addressed. Every addition, relabel, retirement, red-team case, or partition change creates a new version linked to its parent and accompanied by provenance and a change log.
- Every benchmark snapshot references the exact corpus version used. Candidate corpus versions are compared with their parent before activation.
- Each corpus version has a visible working set and protected holdout. Remediation generation does not receive holdout labels. Exposed holdouts move to the working set and are replaced in a new version.
- Drift detection creates review proposals and never publishes automatically. Signals include input and tool-shape changes, repeated unknown failures, evaluator disagreement, human acceptance decline, unsafe recommendation changes, dependency or policy changes, and cost, latency, retry, or trajectory shifts.
- For Crucible users, Crucible is the managed source of truth for mutable workflow state. It stores approvals, reviewers, assignments, comments, delivery status, and audit history against immutable local evidence digests.
- Future branch, commit, pull-request, and deployment delivery are adapters over the remediation artifact. They do not alter evaluation semantics or require live traffic routing.

## Testing Decisions

- Test at the highest stable seam: invoke the pipeline command with versioned fixture artifacts and assert emitted contracts, exit status, declared filesystem effects, and working-tree state.
- Prefer observable behavior over internal function tests. Internal unit tests are appropriate only for deterministic canonicalization, digesting, statistical calculations, and safety predicates that are difficult to isolate at the command seam.
- Extend the existing schema-checking pattern so every new contract has valid examples, invalid examples, version checks, and cross-language compatibility checks.
- Build representative fixture sets for all four evaluation families, including accepted, rejected, abstained, missing-evidence, missing-timing, high-risk, and conflicting-evaluator cases.
- Verify imported and replay-generated candidate results produce identical downstream behavior when their normalized contents are equivalent.
- Verify default smoke and imported-result benchmark commands make no network calls and incur zero external cost.
- Verify deterministic benchmark runs are reproducible after excluding declared nondeterministic metadata such as generation timestamps.
- Verify scorecard denominators keep abstention separate from recommendation accuracy and preserve full coverage accounting.
- Verify every confidence band at its sample-count and quality boundaries, including one case below and above each threshold.
- Verify speed claims require paired timing, report unavailable when timing is absent, and enforce median and p95 rules independently.
- Verify budget preflight refuses unbounded or over-cap replay, cache hits avoid repeat spend, budget exhaustion emits a partial snapshot, and partial snapshots cannot pass replay gates.
- Verify tool and loop cases cannot use the single-shot replay path.
- Verify high-risk cases always become review-only or abstain in v1.
- Verify issue classification emits exactly one primary class and one next action for each terminal failure.
- Verify remediation proof compares frozen baseline and post-fix snapshots under the same policy and cannot alter the judging gate.
- Verify remediation generation cannot read protected holdout labels and that final proof still includes holdout gate results.
- Test apply and rollback against temporary Git repositories. Cover approved success, absent approval, stale base revision, changed affected files, digest mismatch, patch conflict, failed post-apply validation, safe restoration, successful rollback, and rollback refusal after later edits.
- Verify generation, approval, rejection, and hold leave the working tree and Git history unchanged.
- Verify local operations never create branches, commits, pushes, pull requests, or other remote state.
- Verify corpus digests are stable, old versions remain readable, label correction creates a new version, benchmark snapshots retain their original version reference, and parent-versus-candidate deltas are visible.
- Verify drift signals create proposals only and require authorized approval before a new corpus version becomes active.
- Use the existing pipeline smoke, contract checks, and skill smoke as prior art. Keep repository-level `format` and `check` as the final validation gate for every implementation ticket.

## Out of Scope

- Live model traffic routing or a runtime AI gateway.
- Automatic production changes or autonomous remediation application.
- Applying a remediation without explicit approval.
- Force-applying stale or conflicting remediation evidence.
- Local automatic commits, branches, pushes, pull requests, deployments, or remote issue creation.
- Default online replay or provider spend in CI.
- High-risk substitutions becoming release-ready through a global override.
- Public benchmarks replacing customer traces and accepted outputs as primary evidence.
- A separate Crucible evaluator, trace format, confidence calculation, or release-gate implementation.
- Final pricing tiers, packaging, billing, or hosted deployment architecture.
- Crucible branch, pull-request, deployment, and notification adapters in local v1.

## Further Notes

- Numeric scorecard thresholds are conservative v1 defaults and must retain their provenance in policy artifacts. Task families may tighten them; weakening safety rules requires an explicit versioned policy decision.
- The implementation should deepen the existing pipeline and contract modules rather than copy behavior into the skill. The skill remains the user-facing workflow and orchestration layer.
- The implementation-ready v1 scope is complete through the dependency-ordered tickets. Follow-on changes should update this spec and the implementation tracker together.
- The product remains local-first: evaluation and remediation actions do not create commits, branches, pushes, pull requests, deployments, or other remote state. Repository changes follow the normal reviewed Git workflow.
