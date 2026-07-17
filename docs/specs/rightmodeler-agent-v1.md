# Rightmodeler Agent V1

- Status: `planned`
- Scope: local-first autonomous agent layered over the existing skill and pipeline
- Depends on: `docs/specs/rightmodeler-eval-pipelines-v1.md` (the evaluation engine and its contracts)
- Audience note: this spec is written to be implementable without access to the
  planning conversation. Where a decision looks arbitrary, the rationale is
  stated inline.

## Problem Statement

Rightmodeler today is a one-time report. A user runs the skill, learns that a
cheaper model preserves quality on their real traces, and applies a swap. The
moment that run finishes, the result starts going stale: new models release
weekly, provider prices change, and incumbent models get deprecated, delisted,
or repriced. Re-evaluating is an unbudgeted manual project, so nobody does it,
and users silently drift back to overpaying or — worse — stay on a model that
is about to be shut off.

The user wants this to be watched for them: a named agent that periodically
re-evaluates their pipeline against the current model catalog and delivers a
reviewable pull request with evidence when — and only when — a change clears
their own quality and savings bar. It must not require hosting, accounts, or
uploading trace data anywhere, because Crucible (the managed platform) does not
exist yet and trace data is sensitive.

## Solution

Ship the **rightmodeler agent**: a headless, scheduled command that runs on the
user's own machine (or their self-hosted CI runner), reuses the existing
ingest → analyze → replay → judge → snapshot workflow unchanged, and opens an
evidence-backed pull request when a model swap clears the gates declared in a
small policy file.

The agent is deliberately a thin delivery layer, coupled to the core only
through the shared contract schemas, the `.rightmodeler/` artifact directory,
and the existing command entry points. Improvements to the evaluation engine
flow into the agent without agent changes.

Each scheduled run is incremental: it diffs the current provider model catalog
against a local run ledger and evaluates only what is new, re-ranks
already-scored candidates for free when prices drop, and checks the incumbent
model's catalog metadata for deprecation, delisting, or price increases. Most
runs cost cents and end in a recorded abstention. When a candidate clears the
policy gates on a fully evaluated corpus, the agent opens one minimal,
receipt-style pull request. The pull request is the only thing that ever leaves
the machine besides the model-provider API calls that replay already makes.

Boundary amendment. The eval-pipelines v1 spec forbids local operations from
creating branches, commits, pull requests, or remote state, and reserves
delivery adapters for Crucible. This spec deliberately amends that boundary:
the agent surface — and only the agent surface — may create exactly one branch
and one pull request per cleared recommendation, and only when the user has
explicitly installed the agent. The pipeline and skill retain their
non-mutating guarantees unchanged. The agent is the first delivery adapter over
the existing immutable evidence artifacts, running locally instead of on
Crucible.

Positioning. The agent is a distinct named product, not a workflow checkbox.
Its product surface is the policy file, the run ledger and status command, and
the pull request. The same policy file is designed to be pointed at a hosted
Crucible tier later ("always-on, no machine required") without changing shape;
building any hosted component is out of scope here.

## User Stories

1. As a developer with real inference spend, I want an agent that periodically re-evaluates my pipeline against new models, so that savings opportunities are found without me budgeting time for them.
2. As a developer, I want the agent delivered as a pull request with evidence, so that reviewing a model swap takes minutes and merging stays a human decision.
3. As a developer, I want the agent to run entirely on my own machine or my own CI runner, so that my traces and corpus never leave infrastructure I control.
4. As a developer, I want my benchmark corpus kept out of git and out of third-party storage, so that trace-derived data never lands in git history or an external service.
5. As a developer, I want the pull request to be the only remote artifact the agent creates, so that I can reason simply about what egress the agent adds.
6. As a developer, I want to install the agent with one command that registers its own schedule, so that I never hand-edit crontab or launchd plists.
7. As a developer, I want an uninstall command that removes the schedule cleanly, so that trying the agent is reversible.
8. As a developer, I want the agent offered at the end of a successful skill run, so that onboarding flows naturally from the moment the workflow has proven itself on my repo.
9. As a developer, I want a generated policy file with visible defaults, so that every guardrail is explicit, editable, and reviewable in my repo.
10. As a developer, I want a quality floor in the policy, so that no swap is proposed unless the candidate meets my bar on my own accepted outputs.
11. As a developer, I want a minimum-saving threshold in the policy, so that the agent does not open pull requests for marginal wins.
12. As a developer, I want a per-run cost cap with a safe shipped default, so that a scheduled job can never surprise me on my provider bill.
13. As a developer, I want a never-touch list of step and file patterns, so that sensitive steps are never candidates regardless of the numbers.
14. As a developer, I want the schedule itself declared in the policy file, so that cadence is configuration, not code.
15. As a developer, I want each run to evaluate only models and prices that changed since the last run, so that weekly runs stay near-free instead of re-proving known results.
16. As a developer, I want already-evaluated candidates re-ranked when their price drops, so that a past rejection on cost can become a recommendation without spending tokens.
17. As a developer, I want the agent to check my current model's catalog metadata every run, so that deprecation, delisting, or a price increase on the incumbent triggers an evaluated replacement proposal.
18. As a developer, I want budget-exhausted work deferred to the next run rather than judged on partial evidence, so that no pull request is ever backed by an incomplete evaluation.
19. As a developer, I want a run that cannot afford even one candidate to abort early with a clear ledger message, so that a too-low cap is a visible configuration problem rather than silent degradation.
20. As a reviewer, I want the pull request diff limited to the minimal model-identifier change, so that review is a one-line decision, not a code audit.
21. As a reviewer, I want a short receipt in the pull request body — quality score against my floor, projected saving, sample count, corpus age and version, judge method, run cost — so that the claim is auditable at a glance.
22. As a reviewer, I want full evidence collapsed below the receipt and pinned by content digest, so that depth is available without polluting the summary.
23. As a reviewer, I want exactly one pull request per proposed swap, so that recommendations are independently reviewable and mergeable.
24. As a reviewer, I want the agent to treat my closing of its pull request as a lasting no for that swap, so that I train the agent by using normal review actions instead of configuration.
25. As a reviewer, I want the agent to never re-open or duplicate a pull request for a swap that already has an open or closed pull request, so that the agent stays quiet once I have answered.
26. As a developer, I want a status command showing last run, next run, outcome, and spend, so that I can verify the agent is alive without reading logs.
27. As a developer, I want every run appended to a local run ledger, so that abstentions, deferrals, spend, and decisions form an auditable history.
28. As a developer, I want the skill to warn me when scheduled runs have stopped happening, so that a dead cron job does not masquerade as "no savings found."
29. As a developer, I want a periodic plain-language digest — including "checked N new models, none cleared your floor" — so that correct abstention is visible as vigilance rather than absence.
30. As a developer whose model reference is not a plain string in code, I want the agent to edit the configuration default it can safely identify or abstain with an explanation, so that it never guesses at refactors.
31. As a team, we want the same agent runnable from a self-hosted CI runner, so that the schedule survives laptops sleeping while data still stays on our infrastructure.
32. As a security-conscious adopter, I want the documentation to state plainly that replay sends trace content to model providers, so that the privacy line — provider API calls yes, git and third-party storage no — is honest.
33. As the product maintainer, I want the agent coupled to the core only through contracts, artifacts, and command entry points, so that evaluation improvements ship to agent users with no agent release.
34. As the product maintainer, I want incumbent baseline scores recorded in the ledger from the first release, so that a future quality-regression guard is a feature addition rather than a data migration.
35. As the product maintainer, I want the agent to survive four consecutive unattended weekly runs on two real pipelines before launch, so that "product" is a measured claim rather than a demo.

## Implementation Decisions

- The agent is part of the skill's toolkit, exposed as `agent` subcommands: `install`, `uninstall`, `run`, `status`. No new application or package is created; the product identity lives in the name, the policy file, and the pull request.
- The agent consumes only: the existing command entry points (ingest, analyze, shortlist, replay, judge, report), the shared contract schemas, and `.rightmodeler/` artifacts. It never imports pipeline internals.
- Execution is headless. No coding-agent or LLM orchestrator runs in the scheduled path; the only LLM calls are the replay and judge calls the core workflow already makes.
- `install` registers the schedule with the operating system's native scheduler on the user's machine, defaulting to weekly. The documented team variant is the same `run` command triggered from a self-hosted CI runner. GitHub-hosted runners are unsupported in v1 because the corpus must not be committed or uploaded.
- The policy file lives in the repository, is generated by `install` with all defaults written out explicitly, and has exactly five keys: `quality_floor` (default 0.90, matching the eval-pipelines target policy), `min_saving_pct` (default 20), `max_cost_per_run_usd` (default 5), `never_touch` (step and file patterns), and `schedule`. Latency budgets and provider allowlists are explicitly deferred.
- The run ledger is a new append-only artifact under `.rightmodeler/`, with a versioned contract schema. Each entry records: catalog snapshot digest, corpus version, evaluated (step, candidate, price-at-evaluation) tuples with scores, incumbent baseline score, deferrals, spend, outcome (proposal, abstention, deferral, abort), and pull-request decisions observed (open, merged, closed).
- Incremental evaluation: each run fetches the provider model catalog, diffs against the ledger, and evaluates only unevaluated (step, candidate) pairs or pairs whose corpus version changed. A corpus digest change invalidates ledger entries for that corpus.
- Price re-ranking: ledger entries store price at evaluation time. When the current catalog price for an already-scored candidate is meaningfully lower, cost projections are recomputed and gates re-checked without any replay, because quality scores do not depend on price.
- Metadata guard: every run checks the incumbent model's catalog entry for deprecation notice, delisting, or price increase. A triggered guard promotes replacement evaluation into the current run and is stated as the reason in the resulting pull request or digest.
- Budget semantics reuse the existing replay-budget machinery: preflight worst-case estimate against `max_cost_per_run_usd`; candidates that do not fit are recorded as deferred and drain in subsequent runs; a run that cannot afford its cheapest pending candidate aborts early with an actionable ledger message. A pull request is never produced from a partially evaluated candidate.
- Gates for opening a pull request: the candidate has a complete benchmark snapshot on the current corpus version, meets `quality_floor`, meets `min_saving_pct`, touches no `never_touch` pattern, and passes the release gates the snapshot already carries. Otherwise the run records an abstention with the failing gate named.
- The pull request diff is the minimal model-identifier change at the locations the pipeline analysis already maps. If the model reference is indirect (environment variable, configuration service), the agent edits the visible configuration default or abstains with an explanation; it never restructures code.
- The pull request body is receipt-style and short, adopting the conventions that make Greptile reviews readable: fixed section order, headed sections that are collapsible but expanded by default, tables for enumerable facts, a small footer, no emoji, no prose padding. The sections, in order: (1) a one-sentence claim naming the swap and why it surfaced now (new model, price drop, or incumbent metadata guard); (2) a two-column receipts table — quality score vs. floor, projected monthly saving from observed trace volume, sample count, corpus version and age, judge method, run cost; (3) a per-step summary table when more than one location changes; (4) the full report inside a collapsed details section; (5) a footer line carrying the benchmark snapshot digest, the ledger run reference, and the sentence telling the reviewer that closing the pull request is a lasting no. Abstentions never produce pull requests or comments.
- Precision over volume, Greptile's published core lesson, is enforced structurally rather than by prompt: one pull request equals one fully evaluated, gate-clearing swap; there is no severity ladder, no advisory comment tier, and nothing ships below the gates. The closed-pull-request-means-no ledger rule is the agent's feedback loop, playing the role Greptile's reaction-embedding filter plays for review comments.
- Pull-request hygiene: one pull request per swap; deterministic branch naming derived from step and candidate; idempotency checked against existing open and closed pull requests before creation; a closed-unmerged pull request is recorded in the ledger as a standing rejection of that (step, candidate) pair.
- Remote interaction uses the user's existing GitHub CLI authentication. The agent creates exactly one branch and one pull request per cleared recommendation and performs no other remote actions. This is the sole, explicitly opted-in exception to the local non-mutation rule, and it lives only in the agent delivery layer.
- Privacy line, stated in docs and onboarding: replay inherently sends trace-derived content to model providers; the agent adds no other egress. Corpus and ledger stay on the user's machine, out of git (the corpus directory remains ignored) and out of third-party storage.
- Observability: `status` renders last run, next scheduled run, last outcome, and cumulative spend from the ledger plus a heartbeat file each run touches. The skill checks the heartbeat during normal use and warns when more than two scheduled intervals have elapsed without a run. The digest ("checked N new models, none cleared your floor") is derived from the ledger and surfaced through `status` and at the end of skill runs.
- Deferred but designed-for: a quality-regression guard that replays the incumbent (baselines already recorded in the ledger), push-based model-release triggers, latency and provider-allowlist policy keys, and the hosted Crucible tier consuming the same policy file and ledger contracts.
- Onboarding: after a successful interactive skill run, the skill offers agent installation as a named product step. Installation without a prior successful skill run is unsupported in v1, because the corpus and analysis artifacts the agent replays against are produced by that run.

## Testing Decisions

- Test at one new seam: invoke `agent run` as a command with a fixture model catalog injected in place of the live catalog fetch and delivery in dry-run mode, then assert on emitted artifacts — ledger entries, pull-request intent (branch name, diff, body), heartbeat — plus exit status and working-tree state. Dry-run delivery emits a pull-request intent artifact instead of calling the GitHub CLI, making every decision assertable offline. Everything below this seam is already tested at the pipeline command seam and is not re-tested.
- Good tests assert external behavior only: given a ledger state, a catalog fixture, a corpus version, and a policy file, the run produces exactly these ledger entries and exactly this pull-request intent (or none). No assertions on internal functions.
- Fixture matrix to cover: first run on empty ledger; no catalog changes (recorded abstention, zero spend); new candidate clearing all gates (intent produced); new candidate failing quality floor, failing minimum saving, and matching never-touch (named abstentions); price drop on a scored candidate flipping the gate without replay spend; incumbent deprecation and incumbent price rise triggering the metadata guard; budget deferral draining across two consecutive runs; preflight abort on an unaffordable cap; corpus digest change invalidating ledger entries; existing open and closed pull request for the same swap suppressing creation; indirect model reference producing a configuration edit or explained abstention.
- Verify no pull-request intent is ever emitted from a partial snapshot, mirroring the existing budget-gate tests.
- Verify a dry run makes no network calls and mutates nothing outside `.rightmodeler/`, following the existing zero-external-spend smoke pattern.
- Ledger and pull-request-intent schemas get valid and invalid examples in the contract test suite, following the existing schema-checking pattern.
- Scheduler registration (`install`/`uninstall`) is covered by a smoke test that asserts the generated scheduler entry and policy file contents, not by executing the OS scheduler.
- Launch gate (manual, not CI): four consecutive unattended weekly runs on two real pipelines — this repository's own judge/replay pipeline and an externally realistic pipeline we operate (a LangGraph example application, unless a design partner materializes) — with zero crashed runs, zero unjustifiable pull requests, every run ending in a defensible pull request or a ledgered abstention, and total spend under the default cap.
- Prior art: pipeline smoke tests, contract schema checks, and skill conformance checks. Repository-level `format` and `check` remain the final validation gate.

## Out of Scope

- Crucible or any hosted execution, dashboard, credits, or billing.
- GitHub-hosted runner support, committing the corpus to git (encrypted or not), and runtime trace-store integrations for fetching fresh traces in scheduled runs.
- Auto-merge, in any configuration.
- Any remote action beyond one branch and one pull request per cleared recommendation.
- Quality-regression replay of the incumbent model (data recorded now, feature later).
- Push-based model-release detection; the schedule is the trigger in v1.
- Latency budgets and provider allowlists in the policy file.
- LLM-driven pull-request authoring or any coding agent in the scheduled path.
- Multi-repository or fleet management.
- Changes to evaluation semantics, judging, confidence, or release-gate policy — those belong to the eval-pipelines spec.

## Further Notes

- The eval-pipelines v1 spec's "never creates remote state" rule and its Out of Scope entry reserving pull-request delivery for Crucible adapters are superseded, for the agent surface only, by the boundary amendment above. That spec's language should be updated to reference this one when the agent ships.
- The marketing page for the agent already promises this product shape (policy guardrails, evidence-backed pull requests, never auto-merge, abstention as a feature). Implementation should keep the shipped policy keys consistent with the page or update the page in the same change.
- The default cost cap of five dollars assumes incremental weekly runs of zero to two candidates at roughly $0.20–$1.50 per candidate evaluation; it is a visible policy line, not a hidden constant.
- The two-tier product intent, for context: this local agent is the free, self-hosted tier; a hosted tier (Crucible) later runs the same policy continuously. Nothing in this spec builds the hosted tier, but contracts introduced here (policy, ledger, pull-request intent) should be treated as future Crucible inputs and versioned accordingly.
