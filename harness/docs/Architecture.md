# Architecture

The rightmodeler harness and the agent that operates it.

This document describes the system. For the build sequence and phase gates, see
[plan.md](plan.md).

## 1. The pattern

The harness is a **cost-asymmetric verification harness**. A cheap, deterministic,
deliberately over-inclusive generator nominates candidates. Expensive compute is spent only on
those candidates. More expensive compute adversarially re-examines the result before a human
sees it. Every stage's contract is an immutable object in a store, and every stage only ever
adds to state.

That shape is what makes re-runs, crash resume, mixed backends, and wide fanout safe by
construction rather than by coordination.

One property of this domain reshapes the whole design: a verdict here is **statistical**, not
discrete. A partial result is not a partial answer, and a wrong recommendation ships degraded
quality into production rather than merely wasting review time. The system is therefore
precision-first, with abstention as a first-class terminal verdict.

## 2. Identity

Three identity rules exist because the obvious alternative silently destroys paid evidence.

### stepId is an AST fingerprint

```
stepId = sha256(projectId, normalizedPath, enclosingSymbolPath, normalizedCallShape)
```

`normalizedCallShape` covers the callee, the argument keys, and the enclosing function or
class. Line numbers and same-slug ordinals are display fields only.

A line number re-keys the step on any added import. An ordinal re-keys every later call in a
file when one is inserted. Either one orphans a family's ledger and drops it to `n = 0` while
the run reports success. Ambiguous movement forces explicit revalidation. Evidence is never
silently migrated.

### evidenceQuestionId decides what may be pooled

```
evidenceQuestionId = sha256(
  corpusVersionId, promptRevision, gatePolicyVersion,
  stepFingerprint, evaluatorPlan, replayMode
)
```

Without it, facts recorded against a changed corpus, a changed prompt, or a changed gate
threshold pool with older facts, and the verdict is computed across incompatible questions.

Judge model and judge version are deliberately **not** part of this key. They are a nuisance
dimension, pooled with measured judge-agreement carried as extra variance. A partition key
that includes every dimension fragments a 24 case family below every minimum and abstains
forever, which is a different way to be wrong.

### Reconciliation happens before any spend

Trace records and scanned call sites are reconciled immediately after `scan` and `ingest`, and
before `corpus` or any paid stage. Otherwise early evidence is keyed by provider identifiers or
fallback identifiers, and can never be joined to scanner call sites without invalidating
everything already paid for.

## 3. State

### Typed facts, not one row type

A single trial row conflates physical requests, logical executions, evaluator assessments,
re-judgements, and spend. Two position-swapped judge calls plus a later re-judge then inflate
`n` for what is one candidate outcome.

The ledger stores immutable typed facts linked by identifiers.

| Fact             | Grain                                 | Key fields                                                                                                                                                |
| ---------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Execution`      | one logical candidate run of one case | `executionId`, `evidenceQuestionId`, `caseId`, `stepId`, `candidateId`, `trajectoryId`, `corpusSplit`, `selectionStage`, `terminalOutcome`, `finalOutput` |
| `RequestAttempt` | one physical HTTP request             | `attemptId`, `logicalCallId`, `executionId`, `streamOutcome`, `usage`, `costUsd`, `costIsEstimate`                                                        |
| `Assessment`     | one evaluator judgement               | `assessmentId`, `executionId`, `evaluatorId`, `metricName`, `score`, `passed`, `rubricVersion`, `artifactRef`                                             |
| `SpendEvent`     | any paid action by any actor          | `actor`, `phase`, `costUsd`, `provider`, `reconcilableTo`                                                                                                 |

An `Execution` materializes into exactly one outcome. Every attempt is charged. Exactly one is
scored.

Facts are written as immutable objects, never appended into a single replaced blob. That also
removes the shard-overwrite failure entirely: two workers can never name the same object, so an
archive extracted over the store is genuinely additive.

### The Store contract

```ts
interface Store {
  get(key: string): Promise<Bytes | null>;
  list(prefix: string): Promise<string[]>;
  putImmutable(key: string, body: Bytes): Promise<void>;
  compareAndSwap(
    key: string,
    expected: Version,
    body: Bytes,
    fence: FenceToken,
  ): Promise<boolean>;
}
```

Fencing tokens are required, not optional. Without them, a worker whose lease expires can still
commit stale results or clear the lock of the worker that reclaimed its work. Fencing makes the
late write lose.

There is an `fs` implementation for local runs and a blob implementation for the deployed
agent, and `paths.ts` returns **keys** rather than filesystem paths. In the deployed agent the
runtime is ephemeral, a sandbox is explicitly not durable storage, and sandboxes are keyed per
session, so a scheduled run and a channel session would otherwise each see a different, empty
dataset.

### On-disk layout

```
<store>/<projectId>/
  project.json   INFO.md   config.json
  setup/         setup-state.json, call-site-inventory.json
  cases/         immutable content-addressed corpus, per-stratum sampling weights
  steps/         <stepId>.json, the locked unit
  facts/         immutable Execution / RequestAttempt / Assessment / SpendEvent objects
  judgements/    <runId>/invocation-NNN.json, forensic artifact per paid invocation
  budget/        <runId>.json, reservation ledger
  confirm/       <familyId>/plan.json, the delta-debugging frontier
  verdicts/      <family>.json, derived
  runs/          <runId>.json
  reports/
```

## 4. Stages

| Stage                                      | Cost          | Produces                                                           |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------ |
| `init` / `setup`                           | mixed         | resumable onboarding, `INFO.md`, generated matchers, baseline scan |
| `scan`                                     | free          | `StepRecord` per call site, status pending                         |
| `ingest`                                   | free          | normalized trace records                                           |
| `reconcile`                                | free          | trace records joined to call sites, ambiguity policy applied       |
| `scrub`                                    | free          | PII removed, fails closed                                          |
| `corpus`                                   | free          | immutable content-addressed case set with stratum weights          |
| `audit`                                    | human         | reference correctness ceiling, stratified by family                |
| `shortlist`                                | cheap         | ranked candidates, capability filtered, price filtered             |
| `replay`                                   | high          | executions and attempts                                            |
| `revalidate`                               | high          | more samples, swapped judge family, swapped output order           |
| `confirm`                                  | highest       | cascade evidence for a swap set                                    |
| `aggregate`                                | free          | `FamilyVerdict`                                                    |
| `enrich`                                   | free          | owners, spend attribution, blast radius                            |
| `report` / `export` / `metrics` / `status` | free          | read-only projections                                              |
| `apply`                                    | machine-gated | branch, draft PR, review request to owners                         |
| `watch`                                    | free          | review replies, CI triage, terminal event on merge                 |

`scan` is deliberately over-inclusive. A matcher's `noiseTier` is a scheduling signal, never a
severity signal.

## 5. Scanner

Matchers are pure functions:

```ts
match(content: string, filePath: string): CandidateMatch[]
```

They are gated by tech detection, carry `filePatterns` and `noiseTier`, and declare
`examples[]` that must fire in an auto-discovered fixture test. A matcher whose examples do not
fire cannot be registered.

The initial set covers the shapes that account for the overwhelming majority of real
repositories: OpenAI SDK, Anthropic SDK, AI SDK (`generateText`, `streamText`,
`generateObject`), LangChain for JavaScript and Python, LangGraph, LiteLLM, and model pins in
configuration. Breadth arrives through the declarative compiler, which is the actual leverage,
rather than through a target count. A false call site pollutes the spend map, and the spend map
is the one artifact a human reads before authorizing spend.

### Evaluator discovery requires a mutation check

A test file beside a call site may only exercise a retry wrapper with a mocked client.
Proximity is not exercise. Before a step is promoted from "calibrated judge" to "deterministic
check", the harness corrupts the recorded output, re-runs the check, and promotes only if the
check fails. This is roughly fifty lines of code and it is the difference between a signal and
a lie.

### Generated matchers

Setup can ask a model for additional matchers covering a bespoke framework. Model output is
strict JSON data compiled without evaluating generated code, and is rejected on:

- ReDoS risk, glob breadth, match explosion, path traversal, slug collision
- a `g` flag, because a shared regex carrying `lastIndex` makes scans nondeterministic across
  an unchanged repository
- a pattern that matches the empty string, which fires on every file
- examples not matched by a declared pattern, asserted inside the schema rather than only in a
  downstream test
- a missing `closesSurfaceIds`, which binds the matcher to the coverage surface it was accepted
  to close

Rejection removes the matcher from the generated file, the live registry, and every persisted
record.

### Coverage gate

A frozen, versioned policy object, plus ground-then-strictly-validate reconciliation of the
model's claimed surfaces against the scanner's real file universe, plus an attempt ledger, plus
a hard stop before any paid work.

Plus one check specific to this domain: reconcile call-site-attributed spend against the
provider invoice total and fail below a configured share. Without it, a repository that routes
every model call through one unrecognized helper passes coverage vacuously and reports a
fraction of its real bill.

## 6. Replay

### Correlation is injected, never inferred

Recovering `stepId` by matching request bodies is not identifiable. Two concurrent cases
issuing identical requests swap attribution. An SDK-internal retry and a deliberate application
retry are byte-identical. A diverging tool loop desynchronizes any positional match, and its
extra iterations are dropped, which makes the worse candidate look better.

The case driver owns the run, so the case driver injects the correlation:

```
{ runId, caseId, stepId, executionId, logicalCallId }
```

by header where the SDK forwards headers, and by a process-bound side channel where it does
not. The proxy stamps `attemptId` on every physical request. **A request arriving without
correlation metadata fails closed.** It is never guessed at.

### The proxy is interception and metering only

A proxy sees a model response. It does not see tool execution, recovery behavior, application
state, or the final answer. A candidate can emit a syntactically valid tool call that fails
downstream and produce a wrong terminal answer while the proxy has already recorded something
that looks successful.

So the **case driver emits the terminal execution envelope**, joined by `executionId`, and that
envelope is what gets scored. The proxy does interception, attempt capture, metering, and lease
enforcement. It does not decide outcomes.

### Streams end by state machine

Per-provider parsers classify each stream as `completed`, `provider_error`,
`client_cancelled`, or `truncated`, with bounded idle timeouts and hard deadlines. Chunks spool
to disk rather than being held whole in memory.

Ending on socket close alone records an upstream reset as a completed answer. Refusing
deadlines entirely lets a half-open socket hold a worker and its budget reservation forever.
Both are wrong.

### Retries

`logicalCallId` is assigned before entering the SDK. Every physical attempt receives its own
`attemptId`. Every attempt is charged. Exactly one terminal execution is scored.

### Fallbacks

SDKs that pin their own base URL are detected during `scan`. The fallback is TLS interception
with a sandbox-trusted CA, and after that an authored per-repository adapter.

### Live docs preflight

Before any provider work, and before the proxy's request and response shapes are trusted, the
harness fetches the current provider API documentation and validates base-URL variable names,
endpoint paths, and the location of the model field. Shipped snapshots are dated; live
documentation wins on any conflict. No model list is ever pinned.

### Sandboxes never score

Sandboxes return raw execution envelopes. The host scores them. Every returned fact is
re-validated before entering the ledger: declared identifiers must match the object key,
`caseId` must exist in the immutable corpus, and `runId` must be one the orchestrator launched.
Incoming archives are allowlisted by entry path.

The sandbox runs client code against outsider-authored trace content. An injected tool output
that can write a passing score for cases it never ran leads straight to an unattended pull
request.

## 7. Statistical contract

**Selection.** Split-corpus. Shortlist on one half, confirm the single winner on the held-out
half, and gate on the winner's multiplicity-corrected lower bound. Building a tie group from
corrected intervals while gating the recommendation on an uncorrected point estimate means that
with four candidates at ten trials there is roughly a fifty percent chance that some candidate
whose true rate is 0.60 clears a 0.75 bar, and being cheapest, wins.

**Evaluator assignment is predeclared.** A stratum by evaluator-kind matrix is fixed before
replay, expected cells must be complete, and both sensitivity and specificity are calibrated
against the reference audit. Gating on "the weakest kind present" is still confounded when
deterministic checks land on easy structured cases and the judge lands on hard ones: the family
decision then moves when test coverage changes and the model does not. Per-kind estimands are
published separately unless a validated cross-kind mapping exists.

**Clustering.** Carry `nTrajectories` and `nDistinctSteps`. Resample at the trajectory level.
Refuse a naive interval when there is more than one case per trajectory. A five-node agent over
twenty trajectories presents as `n = 100` and behaves closer to `n = 33`.

**Minimums name their unit.** `MIN_REVIEW_TRIALS`, `MIN_DISTINCT_STEPS`,
`MIN_DISTINCT_TRAJECTORIES`. The legacy constant counted steps; silently reusing it for
executions would let one call site across ten cases clear a bar that previously required ten
call sites.

**Exclusions gate.** A candidate whose call sequence diverges from the recorded one is a
case-level failure, not a dropped row. Refuse `recommend` above a configured excluded fraction,
and always publish the worst-case bound that imputes every exclusion as a failure.

**Availability is a separate gate from quality.** A route that returns excellent answers
eighty-five percent of the time and empty HTTP 200 completions fifteen percent of the time must
not win on filtered conditional quality. Conditional quality and availability are reported and
gated independently, and the release decision uses the worst-case-imputed bound.

**Reference ceiling.** Stratified by family with a per-family minimum before it is applied
there. Modeled as two-sided contamination rather than a scalar cap, because a same-family
candidate reproduces the reference's own errors and is scored equivalent. The auditor may not
use a model in the reference's family, the same exclusion the judge already enforces.

**Mode A optimism is an abstention trigger.** Route to `confirm` when
`prefixProvenance === "model_authored"` **or** `downstreamStepIds` is non-empty. Optimism is an
upstream property, so a terminal step scored on an expensive model's prefix is exactly the case
a downstream-only rule misses. Abstain when the measured delta exceeds the margin over the bar.

**One precedence.** The release gate binds. The pass fraction is a shortlist filter. The
per-case quality floor is validated into the range where an order-consistent outcome is
genuinely Bernoulli. One Wilson implementation with an explicit correction parameter.

**ROI is reweighted or it is not published.** Per-stratum sampling weights are persisted at
corpus time and reweighted to observed traffic before annualizing. Savings are an interval
carrying `costIsEstimate`, stamped `corpus_only`. Cost comes from the `SpendEvent` ledger.

## 8. Confirm

Naive bisection assumes a single monotone culprit. Two swaps that fail only in combination land
in different halves, both halves pass, and the algorithm reports no seed.

1. Run the full recommended set. If it passes, the set is confirmed at the cost of one run set.
2. If it fails, run dependency-aware delta debugging that tests cross-half interactions and
   recurses through every failing subset.
3. `inconclusive` is a legitimate terminal outcome. No complexity bound is promised.

The **case** is the atomic unit that writes a fact. The frontier is persisted at
`confirm/<familyId>/plan.json` and executions stream home mid-run, so a wall-clock timeout
costs the tail rather than the run. The earliest sub-threshold step is reported as the cascade
seed; other members of a failing subset are `uncertain`, never `reject`, because they were not
independently disproven.

Steps with no downstream consumers and an externally authored prefix skip `confirm`. Everything
else is routed to it and abstains rather than borrowing a single-shot number.

## 9. Budget

Streamed cost is unknown until tokens are generated, so a lease that returns a payment-required
error once exhausted detects overspend rather than preventing it. Thirty streams admitted just
under the remaining lease exceed it together, and cutting them mid-stream preserves the budget
only by manufacturing invalid executions.

Worst-case cost is **reserved before forwarding**, computed from context size, maximum output,
and pinned pricing. Concurrency is capped against available reservation. The unused remainder is
refunded on completion. The host holds authorized totals in `budget/<runId>.json`; the proxy
enforces; re-leasing is a host round trip.

Caps are opt-in bounds, not defaults.

## 10. Posture

**Nothing stops early and reports anyway.** Every family ends in a terminal state
(`recommend`, `reject`, `abstain`, `inconclusive`), or the run reports exactly which families
are blocked, on what, and what finishing would cost, as a first-class result. The agent keeps
polling and re-dispatching failed shards, and does not surface a report while the frontier is
non-empty.

**No silent caps.** Any bound on coverage, including top-N selection, sampling, a skipped
family, or a dropped shard, is printed and carried onto the verdict.

**Generous defaults.** Sampling above the minimums. `revalidate` on by default. Two independent
judges on important swaps. `confirm` by default for coupled or model-authored-prefix steps.
Cheaper settings exist and are opt-in.

**Rate limits are throughput to discover, not a ceiling to hide under.** A per-provider adaptive
concurrency controller ramps while requests succeed and backs off multiplicatively on 429 or
5xx, honoring `Retry-After`, with a floor so a transient burst cannot collapse a run to serial.
A rate-limited request is a retry, never an execution outcome, and never counts against a
candidate. Exhausting retries reports `blocked: rate-limit` with the observed ceiling, so the
answer is "raise this limit" rather than a quietly worse verdict.

## 11. Concurrency and recovery

**Locks.** A project-level mutex covers select-and-claim only. Per-step ownership uses
heartbeats and fencing tokens, because PID liveness checks are host-local and every worker has
a different hostname. The orchestrator releases a step the moment its worker's exit code is
non-null, rather than waiting out a backstop interval while static partitioning guarantees
nobody else picks it up.

**Dispatch idempotency.** A tool call identifier is not stable: an interrupted durable step
re-runs the model call and can emit a different identifier, launching the same fleet twice. The
key is a canonical semantic run-spec digest computed before dispatch and claimed through an
exclusive create. On collision, the existing `runId` is returned. Dispatching tools enqueue and
return immediately rather than owning multi-hour work inside one durable step.

**Torn reads and salvage.** Facts are immutable objects, so a reader never observes a partial
write. Malformed objects are salvaged per item with an explicit `droppedRows` count that flows
onto the verdict. A silent shrink is the same confident-wrong-number failure the
`evidenceQuestionId` design exists to prevent.

**Hostile pipelines.** Client code runs in its own process group and is killed by negative
process group id on timeout, or a spawned worker keeps burning budget through the proxy after
the driver has given up. Result archives are scoped to named namespaces rather than "everything
newer than a marker", with per-namespace caps that skip rather than throw, so one pipeline
writing a large index into its working directory cannot destroy results already paid for.

**Every sandbox invocation is treated as cold.** A replaced sandbox does not restore
post-template files or processes, and session initialization does not re-run for the
replacement, so the in-sandbox proxy, trusted CA, and checkpoint cache can vanish while the
durable session believes setup already happened. Bootstrap and verify the proxy before every
job. Persist every important artifact externally.

## 12. Security

`cases/` and `trials/` hold verbatim production prompts and completions, which is customer
personal data rather than code snippets. A mandatory scrub stage sits between `ingest` and
`corpus` and fails closed. Both are never committable by default. Pull request bodies cite
`caseId` hashes, never case content.

Trace text is inert data everywhere it is rendered or judged: fenced, length-capped, forged
markers defused, and flattened before it reaches Markdown, so a trace cannot forge a report row.
Step names, justifications, and candidate outputs are data, never instructions.

Mode B never runs on the host. `local` is Mode A only, where no client code executes. The
container backend honors only allow-all or deny-all, so it cannot provide domain allowlists or
firewall credential transforms; secure Mode B therefore requires either a separately
implemented and tested host gateway for local containers, or a firewall-capable backend. Mode B
**refuses** rather than degrading onto a host with real egress and a real environment, which
would silently falsify the security claim on the default path.

`.rightmodeler/` is a self-severing workspace root inside the client repository: `workspaces:
[]`, a workspace file declaring no packages, and a pinned package manager, so no package manager
walks up into the host monorepo.

## 13. Integrations

Every integration is a package behind a declared contract with its own conformance suite.
Registries are built from the plugin list at load time and consulted everywhere; no integration
is hard-coded at a call site.

| Kind                | Contract                                 | Merge     |
| ------------------- | ---------------------------------------- | --------- |
| Trace adapter       | `detect(sample)`, `adapt(records)`       | additive  |
| Evaluator provider  | `launch`, `status`, `collect`            | additive  |
| Model provider      | `listModels`, `chat`, cost authority     | additive  |
| Matcher             | `match(content, path)` plus `examples[]` | additive  |
| Harness reference   | the `_template.md` question set          | additive  |
| Agent adapter       | `AsyncGenerator<Progress, Result>`       | additive  |
| Notifier / exporter | `notify(params)`                         | additive  |
| Executor            | `launch`, `collect`, `status`            | last wins |
| Ownership / people  | provider lookups                         | last wins |

Plus `commands(program)` for CLI extension. `rightmodeler status --integrations` prints what is
registered and reachable.

### Bring your own eval framework

A synchronous scoring function cannot represent asynchronous experiments, several named
metrics, human labels, artifacts, or rubric provenance. The evaluator contract is therefore
`launch` / `status` / `collect`, returning provider run identifiers, metric names, rubric
versions, raw artifact references, and the provider's own normalized pass decision. The
`Assessment` fact preserves all of it rather than collapsing to one scalar.

Interop runs in three directions. **Evaluators in**: the built-in judge runs only when nothing
better is reachable. **Corpus in**: curated datasets usually carry human-verified references,
which raises the reference correctness ceiling that caps every downstream number. **Results
out**: experiments and dataset runs are pushed back into the tool the team already reviews.

Ingest ships OTel GenAI and OpenAI JSONL first, because OTel GenAI is the vendor-neutral format
that several platforms emit, and the rest follow behind the same contract.

## 14. Skill packs

An index skill that routes, plus one reference file per pipeline shape, loaded on demand:
`vercel-ai-sdk`, `langgraph`, `langchain-js`, `langchain-py`, `crewai`, `dspy`, `mastra`,
`autogen`, `raw-openai`, `raw-anthropic`, `litellm-proxy`, `go-openai`, `ruby-openai`,
`java-langchain4j`, and `_template.md` defining the contract a new file must satisfy.

Each reference answers the same fixed questions: where the model identifier is bound, whether
the SDK forwards correlation headers, whether it honors a base-URL override and which
environment variable carries it, how to mock side-effecting tools from a recorded trace, the
pipeline's natural entry point, and how to detect downstream coupling. Every file begins by
naming the live API documentation to fetch first.

One source ships to both the CLI runbook and the agent subagent. Adding a framework is one
matcher plus one reference file, and `_template.md` is what a fixture test asserts against.

## 15. The working agreement the harness follows

The harness writes code into other people's repositories and spends their money, so its working
principles are mechanical gates rather than prompt advice. Each has a test.

**Think before coding.** At a genuine fork the harness never guesses. Interactively the CLI asks
and waits. Unattended it emits a terminal abstention naming the confusion and what would
resolve it, which is the same principle expressed for a context with no human. An eval asserts
that every ambiguity path ends in a question or a named abstention.

**Simplicity first.** An authored adapter has one required export and a size budget. A generated
matcher is data, not code. No configuration key ships without a consumer, enforced by an
unreferenced-export check and a schema test.

**Surgical changes.** A swap pull request changes model identifiers and nothing else. A diff
linter runs before the pull request opens and rejects any hunk touching anything but a model
literal, a model constant, or its configuration entry: no reformatting, no import reordering, no
drive-by refactor, no comment rewrites, no lockfile churn. A genuinely required adjacent change
is stated in the body as a separate labeled hunk and requested explicitly. This is what makes
the pull request reviewable in thirty seconds, which is the difference between a swap that
merges and one that rots.

**Goal-driven execution.** Every stage declares its success criterion and loops until verified
rather than reporting attempts. `scan` succeeds when coverage is satisfied and reconciled
against the invoice. `replay` succeeds when every expected cell has a terminal execution.
`confirm` succeeds when the frontier is empty. `apply` succeeds when the diff linter passes and
CI is green.

### The target repository's rules outrank ours

Repository analysis reads the host project's own conventions and folds them into `INFO.md`,
which is injected into every prompt and enforced at the diff linter:

- `AGENTS.md` and `CLAUDE.md`, following `@file` includes and the convention where one is a
  pointer to the other
- nested per-directory `AGENTS.md` for the paths a swap actually touches
- `.claude/skills/` and `.agents/skills/`
- `CONTRIBUTING.md`, the pull request template, `CODEOWNERS`, `.editorconfig`
- the formatter and linter actually configured in the repository

Commit message and branch naming conventions are inferred from recent history rather than
assumed. The pull request body renders from the repository's own template when one exists. The
diff is formatted with the repository's formatter before the linter checks it. If the project
forbids a co-author trailer or a particular footer, none is added. If a project skill documents
how to change a model configuration, that skill is followed instead of the generic reference
file.

Conflicts resolve toward the host repository. An unreadable or contradictory instruction is
surfaced as a question or a named abstention rather than overridden silently. A pull request
that violates the reviewer's own stated conventions gets closed regardless of how good the
evidence behind it is.

## 16. CLI

```
npx rightmodeler init
```

is the whole onboarding, resumable, with a machine protocol so a coding agent can drive it
unattended: `--plan --output json` to preview, `--yes --through <phase> --output jsonl` to run
and stream events, and `--max-cost-usd` / `--max-duration` to bound a run.

Exit codes: `0` clean, `1` findings, `2` needs input, `3` a cost or duration limit reached at a
resumable boundary.

Commands: `init`, `setup`, `scan`, `ingest`, `reconcile`, `scrub`, `corpus`, `audit`,
`shortlist`, `replay`, `revalidate`, `confirm`, `aggregate`, `enrich`, `report`, `export`,
`metrics`, `status`, `apply`, `rollback`, `watch`, `sandbox <cmd>`.

There is no interactive approval TUI. It would contradict the autonomy boundary, since nothing
waits for a human before the pull request. Output is headless JSON and JSONL plus reports.

The installed package ships its own documentation so an agent reads the version it actually
has.

## 17. The agent

```
agent/
  agent.ts            model, reasoning, limits, compaction
  instructions.md     the golden rules and the runbook
  instrumentation.ts  telemetry
  tools/              typed wrappers; dispatching tools enqueue and return
  skills/             harnesses/, evidence/, working-agreement/
  subagents/          analyst, adapter-author, auditor, pr-steward
  channels/           eve (real auth), github, slack
  extensions/         github tools, pull-request-author preset
  connections/        MCP over http, OpenAPI provider catalogs
  schedules/          price-decay, drift-watch, pr-watch, budget-report
  sandbox/            deny-all plus provider allowlist, credential brokering
  hooks/              cost ledger, audit persistence
evals/
```

**Every schedule uses the handler form**, including the budget report. A markdown task-mode
schedule discards its output and cannot reach a human, so a report schedule would complete
successfully while nobody ever sees it. Task mode also cannot park, so any approval beneath it
fails fast for the entire subagent chain.

**Pull request lifecycle state is external and sessions are short.** Three independent reasons.
A session token cap is cumulative and cannot be reset, so a weeks-long watcher eventually fails
with no way to ask for more. Inline review threads receive different continuation tokens, so
"the pull request is the session" is false and two threads can concurrently re-prove and push.
The default steering policy cancels an active turn when a new event arrives, after side effects
have already landed.

So `(repositoryId, prNumber)` is the durable aggregate in the store, every session is a short
idempotent worker that acquires a pull-request-level fenced lock, the turn policy is `queue`,
and every mutation is independently idempotent.

**A custom webhook adapter handles formal reviews.** The framework parses review _comments_ but
not the top-level review submission event, so an owner clicking "Request changes" without an
inline comment would never wake the agent. The adapter verifies the signature and feeds its
delivery identifier into the lifecycle log.

**No sleep-polling.** Each durable wake costs another model call, so five-minute polling across
a six-hour fanout is roughly seventy-two continuation calls of pure overhead. Progress arrives
by job-completion webhook and deterministic status schedules. The durable sleep tool is reserved
for short bounded retries inside one active turn.

**Cost is accounted at the provider boundary**, not from root hooks. Parent hooks do not observe
subagent turns, retried steps emit duplicate events, and compaction performs its own paid model
call outside ordinary usage accounting. Attempt cost is distinguished from winning-step cost and
reconciled against provider invoices.

## 18. Autonomy

No human is in the loop before the pull request exists. `open_swap_pr` is guarded only by
machine checks: the verdict is `recommend`, every release gate is green, the evidence revision
equals HEAD, and pre-apply digests match the files on disk. Stale evidence re-proves rather than
writing. There is no force flag.

Then it opens the branch and draft pull request, puts the evidence in the body, and **requests
review from the owners** resolved by `enrich`, appending a remediation lifecycle event.

Because the run is unattended, the pre-pull-request path must never be able to park. Approval
helpers are absent from every pre-pull-request tool by construction, and an eval asserts it.

| Event                                     | Behavior                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| review comment, review submitted, mention | answers with the stored evidence behind the number being questioned                                                         |
| changes requested                         | re-proves against the objection, pushes or narrows the swap set, replies with the delta                                     |
| CI failure                                | pulls the failing job, decides regression versus flake, fixes or converts the verdict to `reject` and closes with reasoning |
| base branch moved                         | re-runs the digest check and re-proves on drift before touching the pull request                                            |
| merged                                    | terminal lifecycle event, realized cost delta recorded, watch ends                                                          |
| closed unmerged                           | records the rejection so the swap is not re-proposed without new data                                                       |

Every paid invocation writes a forensic artifact containing raw responses, both position-swapped
verdicts, repair attempts, and reconciliation diagnostics. Without it, the only way to answer
"why does step 42 pass at 0.78?" is to spend again.

`pr-watch` reconciles open pull requests against the API as a backstop for dropped webhooks and
ends watches whose pull requests merged while a webhook was missed. Watch state lives in
lifecycle events, never in memory.

The agent never merges. Merge, branch update, reference deletion, release creation, and
workflow-file writes are excluded from the tool set.

## 19. Deployment

**Local** needs no cloud account. `npx rightmodeler init`, the container executor for Mode B,
and `local` for Mode A. This is the path a coding agent drives through the runbook.

**Cloud** is the same commands with work fanned out to microVMs in the **client's own account**,
linked by their own CLI and authenticated by their own token. The host keeps the model
credential and injects it only at the egress firewall.

**The agent** is scaffolded by `rightmodeler agent init` and deployed by the client into their
own project. Their source, traces, corpora, keys, and spend stay theirs. Session state is the
durable workflow journal, so there is no database to operate. Self-hosting works with the
workflow data directory on a persistent volume and both framework path prefixes forwarded
unrewritten, noting that the scheduler uses server local time off-platform rather than UTC.

There is no `tenantId` threading. It is not free: it permanently expands identity, locking,
cache, and migration semantics for a tier that does not exist. The client deployment is the
isolation boundary. A managed tier, if it ever arrives, arrives versioned.

## 20. Evals

The gates are safety properties, not "did it answer".

- abstains below `MIN_REVIEW_TRIALS`, `MIN_DISTINCT_STEPS`, or `MIN_DISTINCT_TRAJECTORIES`
- abstains on a high-risk family without deterministic evidence
- abstains when the Mode A optimism delta exceeds the margin
- refuses a naive interval when cases per trajectory exceeds one
- never recommends a coupled or model-authored-prefix step without `confirm` evidence
- refuses to open a pull request on stale evidence, and re-proves instead
- never selects a judge or an auditor from the reference's or candidate's family
- prefers a configured external evaluator over the built-in judge whenever reachable
- never pools a pass rate across evaluator kinds
- promotes to deterministic evidence only after the mutation check fails the test
- gates availability separately from conditional quality
- refuses `recommend` above the excluded-fraction ceiling and publishes the worst-case bound
- no pre-pull-request tool declares an approval other than never
- a request without correlation metadata fails closed
- a replayed dispatch does not launch a second fleet
- a replayed step does not double-comment
- concurrent review threads do not both push
- the watch terminates on merge and does not re-open
- a swap pull request diff touches model identifiers and nothing else
- a rate-limited request is retried, never recorded as an execution outcome
- every ambiguity ends in a question or a named abstention
- no run reports a summary while any family is non-terminal, and every cap is printed

Evals that need real spend are tagged, so continuous integration runs the deterministic suite
per pull request and the full suite nightly. Missing judge credentials fail the suite rather
than skipping it.

## 21. Robustness checklist

Digest-keyed phase checkpoints with output-existence probes and a stale state. Additive merges
everywhere. Dry runs and partial runs. Immutable objects with compare-and-swap and fencing
tokens. A select-and-claim mutex. Heartbeat-based lock reclamation. Bounded retries with
exponential backoff and jitter. A JSON, then field, then refusal repair ladder. Adaptive split
on ambiguity. Worker stdout caps and orchestrator stream caps. A heap watchdog host-side and
inside the proxy. An archive entry allowlist with per-namespace caps that skip rather than
throw. Exactly one allowed egress host per backend. Credential brokering asserted by a test
that no environment value contains the secret. Environment allowlists that replace the process
environment for agent subprocesses. A secret redactor applied before both persist and render.
Fail-loud on unparseable agent output. Fixture-driven matcher tests where every matcher's
examples must fire. Golden prompt snapshots regenerated behind an environment flag. A stub agent
and a stub provider that drive the whole pipeline with zero credentials.
