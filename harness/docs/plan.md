# Build plan

End-to-end plan for the rightmodeler harness and the agent that operates it.

For the technical design, see [Architecture.md](Architecture.md).

## 1. Why

`rightmodeler` began as a skill plus roughly 12,000 lines of Python across two engines that
could not reach each other in production.

- `skills/rightmodeler/scripts/` (6,777 LOC, retired in Phase E) was what users installed.
- `apps/pipeline/` (3,167 LOC plus 2,138 LOC of tests, retired in Phase E) owned the evaluator families, scorecards,
  release gates, remediation lifecycle, and corpus versioning.
- `npx skills add elm-os/rightmodeler` shipped only the first, while `workflow.py` required the
  second to exist on disk.

Engine 2 is therefore unreachable for every external user. That is a distribution bug, and it
is the single clearest signal that the packaging boundary needs to be rebuilt rather than
patched.

Beyond it, the tool has no durable record model, no crash resume, no fanout, no continuous
integration (`.github/workflows/` does not exist), no export targets, no plugin surface, no
onboarding, no scheduling, and no evals of itself. It also cannot say anything at all about a
repository until the user instruments their application and waits for representative traffic.

This plan builds the harness that fixes all of that, in TypeScript, plus a continuously running
agent that operates it: installable and runnable locally under any coding agent through a
`SKILL.md` runbook, and deployable into the client's own cloud account.

## 2. Decisions

| #   | Decision             | Answer                                                                                     |
| --- | -------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Kernel language      | Full TypeScript rewrite. Python is retired only after differential parity.                 |
| 2   | Location             | `harness/` in this repository, joined to the root pnpm workspace. Extractable later.       |
| 3   | Stage 1              | Code-first call-site matchers. Free, no AI, no traces required. Traces enrich, never gate. |
| 4   | State shape          | Locked `StepRecord`, append-only typed fact ledger, derived `FamilyVerdict`.               |
| 5   | Write scope          | Open and update pull requests, request review from the owners, never merge.                |
| 6   | Model swap           | Driver-injected correlation plus an egress proxy, with a live API docs preflight.          |
| 7   | Autonomy             | Unattended through pull request creation. The review is the gate. Then watch until merge.  |
| 8   | Existing eval stacks | First-class. External platforms supply evaluators, corpora, and result sinks.              |
| 9   | Integration shape    | Every integration is a plugin behind a contract with a conformance suite.                  |
| 10  | Where it runs        | Local by default. Cloud fanout into the client's own account. Nothing hosted by us.        |
| 11  | Posture              | Quality over cost. Generous rate limits. Never stop early and report half work.            |

Two adversarial reviews were run against the first draft: an independent four-lens red team and
a separate frontier-model pass. Both found fatal flaws. The design in
[Architecture.md](Architecture.md) is the corrected one, and the corrections are annotated
inline there so the reasoning is not lost and the original mistakes are not reintroduced.

## 3. Layout

```
harness/
  docs/           plan.md, Architecture.md, integrations/*.md
  packages/
    core/         Store (compare-and-swap plus fencing), typed facts, keys, locks,
                  run lifecycle, plugin and config contracts
    scanner/      call-site matchers, tech detection, declarative compiler, reconciliation
    kernel/       evaluators, judge, statistics, scorecards, release gates
    replay/       case driver, correlation injection, egress proxy, Mode A and Mode B
    processor/    agent adapters, prompt assembly, reconciliation, enrichment
    executor/     container and cloud-sandbox fanout (local is Mode A only)
    rightmodeler/ the CLI (npx rightmodeler)
    parity/       differential TypeScript versus Python suite (temporary)
  apps/
    agent/        the agent application
```

The root `pnpm-workspace.yaml` gains `harness/packages/*` and `harness/apps/*`.
`packages/contracts` is extended and versioned, not forked. It remains the one schema boundary.

## 4. Sequencing principle

Prove the dangerous core on one narrow path before building breadth, and land the safety suite
before the first external mutation.

The first draft of this plan did the opposite. It buried attribution identity, ledger grain,
agent lifecycle, and the review path behind fifteen skill packs and eight registries, gated the
entire build on byte-level parity with code that has no consumer in the new design, and allowed
a phase that opens a real pull request to precede the phase that creates the suite which would
catch a wrong one.

## 5. Phase A: one narrow path, end to end

Core, then a minimal but complete vertical slice. One framework, one provider, one evaluator,
one executor.

1. `core`: `Store` with compare-and-swap and fencing tokens, typed facts, keys with traversal
   guards, locks with heartbeats, run lifecycle, plugin and config contracts.
2. `scanner`: matcher contract, tech detection, declarative compiler, the first fifteen
   matchers, the frozen coverage policy object.
3. `ingest` for OTel GenAI and OpenAI JSONL.
4. `reconcile`: join trace records to scanned call sites, with an explicit ambiguity policy.
5. `scrub`, then `corpus` with per-stratum sampling weights, then the reference audit.
6. The minimum typed kernel in TypeScript: materialization, aggregation, release gates.
7. `shortlist`, Mode A `replay` with budget reservation, `aggregate`, `report`.

**Contract work that must happen first.** Two contracts are already wrong and cannot be ported
onto as they stand:

- `packages/contracts/schemas/normalized-run.schema.json` requires `{bundle_id, runs}`, while
  `ingest.py` actually emits `{trace_id, source_format, session_id, step_count, steps}`. A
  TypeScript implementation honoring the schema rejects real Python output; one honoring Python
  violates the declared boundary.
- `benchmark-snapshot.schema.json` pins `evaluation_cost_usd` to a constant zero, which the
  rewrite makes false the moment a paid judge or an external evaluator runs.

Both need a version bump and a migration before anything is ported onto them.

**Gate.** A real repository runs from `scan` to a recommendation with correct identity,
complete expected cells, and a traffic-reweighted ROI interval. Wilson property tests pass
across the full `(k, n)` grid including the degenerate ends, and an assertion covers the unit of
each minimum rather than only its value.

## 6. Phase B: the dangerous core

1. Correlation injection in the case driver.
2. The egress proxy with per-provider stream state machines.
3. The container executor.
4. Mode B.
5. `confirm` with dependency-aware delta debugging.
6. One real external evaluator vertical slice, so the `Assessment` contract is proven against a
   real asynchronous experiment before it is frozen.

The evaluator slice is deliberately here rather than later. Freezing a scalar contract in
Phase A and meeting a real provider in a breadth phase guarantees a late ledger migration, since
real evaluators return several named metrics, asynchronous jobs, and artifacts.

**Gate.** A real three-node LangGraph fixture with a tool call replays end to end under the
container executor with correct attribution, correct retry accounting, and checkpoint
rehydration after a forced restart. A seeded interacting-pair regression, where two swaps fail
only in combination, is isolated correctly. Transport conformance tests run real SDKs against
fault-injecting fake servers covering randomized chunk boundaries, internal retries, timeouts,
cancellations, concurrent identical calls, and truncated usage reporting.

## 7. Phase C: one pull request, safely

1. `enrich`: owner resolution and blast radius.
2. The diff linter.
3. Host-convention capture into `INFO.md`.
4. `apply`.
5. The external pull request aggregate with fenced locking.
6. The review-submission webhook adapter.
7. `pr-steward` and watch termination.

The security and behavioral eval suite and continuous integration land **here, before the first
external mutation**, with a head-repository check, a protected environment carrying reviewer
approval, artifact handoff so the privileged job runs no pull-request-controlled code, and
SHA-pinned actions. This pipeline executes a pull request's own code with a live provider
credential brokered at egress, so the fork check is a hard requirement rather than an inherited
convention.

**Gate.** One full packed-artifact dry run from `scan` to an open pull request. A seeded
non-model hunk is rejected by the diff linter. A seeded review comment and a seeded CI failure
are both handled. Merge ends the watch and does not re-open it.

## 8. Phase D: breadth

Everything the product needs to be broadly useful, now that the core is proven.

- Remaining matchers, driven by real repositories rather than a target count.
- Remaining trace adapters: Langfuse, Braintrust, LangSmith, OpenInference, Helicone, Weave,
  Claude Code, Codex.
- Remaining evaluator providers, corpus import, and result sinks.
- The `harnesses/` skill pack and the `evidence/` skill.
- The cloud-sandbox executor with partitioning, archive hardening, and fact re-validation.
- Agent adapters.
- Remaining channels and schedules.
- The `skills/rightmodeler` runbook rewrite.

**Gate.** Each integration passes the shared conformance test over a recorded fixture. The
runbook runs unattended under two different coding agents against a fixture repository,
asserting the exit-code contract at each step. A bundle end-to-end test installs the packed
tarball into a temporary directory and drives it from the installed path, with every shipped
documentation link resolving. That last test exists specifically because the original defect
this project fixes is a packaging defect.

## 9. Phase E: cutover

Port the remainder of the kernel and retire the Python engines in one commit.

`diagnosis`, `drift`, and `remediation` are **not** consumerless. `apply`, `rollback`,
`drift-watch`, and CI repair all depend on their invariants: stale-revision checks, scoped patch
enforcement, restoration, and rollback proof. Their behavior is ported before `apply` ships in
Phase C, not deferred to here.

## 10. Verification

### Parity is classified, not blanket

Every behavior is labeled `preserve`, `change`, or `retire`. Exact differential tests apply only
to `preserve`. Intentional corrections get normative tests instead.

Blanket parity would be actively harmful. The Python oracle deliberately passes a nine-of-ten
point estimate whose confidence lower bound misses the threshold, and the corrected design gates
on that lower bound. Under blanket parity the corrected implementation either fails the suite or
is forced to reproduce a known bug.

### The parity boundary must include the risky behavior

Comparing evaluation, scorecards, and gates over flattened candidate results cannot detect a
proxy that assigns every response to the wrong step, because both sides would produce the same
snapshot from the same flattened input.

- Black-box differential tests run from a raw trace and a fake provider through to a final
  recommendation.
- Transport conformance tests cover the behavior Python has no equivalent for.
- Recorded cassettes are happy-path only and are explicitly not the evidence for retry,
  streaming, cancellation, or concurrency behavior.

### Canonicalization is a named standard

Cross-language content addressing uses RFC 8785 JSON Canonicalization, with shared byte-level
test vectors covering Unicode escaping, exponent formatting, and negative zero. Pinning float
formatting alone leaves the same corpus with different digests on each side, which silently
invalidates caches and evidence.

### Everything else

- Matchers: examples must fire, plus the mutation check before any promotion to deterministic
  evidence.
- Security: credential brokering, egress policy, archive handling, returned-fact re-validation,
  path traversal, the secret redactor, and the PII scrub.
- End to end with no credentials: a stub agent and a stub provider drive the whole pipeline.
- End to end for real: three open-source repositories, one JavaScript application, one Python
  agent, one Go service. A day-one scan with no traces produces a spend map, explicitly not a
  recommendation. A seeded regression is caught by `confirm`. A weak-evidence family abstains.
- Agent: the deterministic eval suite per pull request, the full suite nightly.

## 11. Constraints this plan respects

- `pnpm` for repository-level and TypeScript work. `uv` was used only before the Phase E
  Python cutover.
- Root commands stay the shared lifecycle entry points: `format`, `check`, `lint`, `build`,
  `check-types`. Run `pnpm format` and `pnpm check` after changes.
- `packages/contracts` and `.rightmodeler/` remain the pipeline contract boundary. A new
  artifact needs a schema, a stable identifier, `additionalProperties: false`, and both a valid
  and an invalid fixture, or the contract check fails.
- `skills/rightmodeler` is the canonical skill source. `.agents/skills/` and `.claude/skills/`
  are generated install targets and are overwritten.
- MIT licensed throughout. No em dashes in copy. No co-author trailers or generated-with
  footers on commits and pull requests.
- Node 24 is a hard requirement of the agent framework.

## 12. Open items

- Secure local Mode B needs a host gateway implementation, because the container backend honors
  only allow-all or deny-all and therefore cannot provide domain allowlists or firewall
  credential transforms. If that gateway is not built, Mode B is documented as available only on
  firewall-capable backends, and refuses elsewhere rather than degrading.
- The model swap uses driver-injected correlation plus an egress proxy. The authored per-repository
  adapter remains the escape hatch for pipelines the proxy cannot reach. Per-language runtime
  shims are dropped.
- The agent framework is beta with documented API drift. Versions are pinned and the eval suite
  is the drift alarm.
