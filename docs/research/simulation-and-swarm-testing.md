# Simulation testing, swarm testing and agent evals: what transfers to rightmodeler

Status: research memo with a decision. Written 2026-11-16. Line numbers refer to the code as
it stood on that date.
Scope: deterministic simulation testing, swarm testing, the Vercel post "Agents are users, so
your software needs evals", and the primary research behind them.

## Decision in one paragraph

None of the three bodies of work gives rightmodeler a new release gate, and no engine code should
change in the next release because of them. Swarm testing and deterministic simulation testing
(DST) work because they have an oracle that does not depend on the input: a crash, an assertion,
an invariant. rightmodeler's only oracle is the output the team accepted for one exact recorded
input. Change the input (omit a tool, inject a fault) and there is no accepted output to compare
against. That, more than sampling bias, is why the stress ideas do not transfer as gates. What
does transfer is (1) one documentation change now, about keeping the end-to-end sandbox
environment deterministic, (2) one measurement to build next, an incumbent control replay that
reports a noise floor and never enters a gate, and (3) vocabulary for the narrative that matches
things rightmodeler already ships. No website copy changes.

## Decision table

| #   | Idea                                                                            | Source                                                 | Decision                                                                 | Reason                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Swarm-style case construction (omit tools, context items, turns)                | Swarm                                                  | Skip                                                                     | A mutated case has no accepted reference output, so the judge has nothing valid to grade against                                                                           |
| 2   | Feature coverage and failure-feature analysis on the existing sample            | Swarm, suppressors paper, FoundationDB coverage macros | Adapt later                                                              | Zero model calls, but slices of a sample sized near the gate minimums are too thin to report without misleading                                                            |
| 3   | Swarm over the Mode B swap set                                                  | Swarm                                                  | Skip                                                                     | The full set is run first and subsets are already enumerated exhaustively; random subsets say nothing about the set that ships                                             |
| 4   | Joint confirmation across recommended families                                  | Swarm (feature interaction)                            | Adapt later                                                              | Swap sets are built per family, yet one approved set can span families; the combination is never run together                                                              |
| 5a  | Provider seeds for replay determinism                                           | DST                                                    | Skip                                                                     | The model is outside the boundary we control; seeds are provider specific and unverified                                                                                   |
| 5b  | Forcing temperature (for example to 0) in replays                               | DST                                                    | Skip                                                                     | The pull request changes only model identifiers, so a forced temperature validates a configuration that does not ship                                                      |
| 5c  | Caching or replaying recorded upstream responses                                | DST, rr                                                | Skip for candidate calls; adapt later for the unswapped prefix in Mode B | A cached answer is not the candidate's answer and is already rejected as a substitution; serving recorded outputs for steps before the first swap would cut noise and cost |
| 6   | Deterministic environment for Mode B (frozen clock, seeded data, stubbed tools) | DST, Vercel                                            | Adopt now (docs only)                                                    | Unrelated nondeterminism in the app counts as a failed case today; guidance is free and safe                                                                               |
| 7   | Fault injection in the Mode B proxy                                             | DST                                                    | Skip                                                                     | The proxy sees only model calls; model-call faults exercise the team's retry code, and there is no accepted output under faults                                            |
| 8   | Virtual clock                                                                   | DST                                                    | Skip                                                                     | Wall time in a replay is paid network latency, which a virtual clock cannot compress                                                                                       |
| 9   | Seeds recorded in the evidence                                                  | DST                                                    | Skip (already shipped)                                                   | Corpus seed, split hash, bootstrap seeds, content-addressed case ids and stored outputs are already persisted                                                              |
| 10  | DST for the harness's own code (budget, resume, confirm plan)                   | DST                                                    | Adapt later                                                              | The one place the method applies as designed; an engineering quality item, not a product feature                                                                           |
| 11  | Incumbent control replay (known-good solution, noise floor)                     | Vercel, DST control runs                               | Adapt next, after a one-day isolation spike                              | Highest value item; report only; must be kept out of selection or it changes the Bonferroni count                                                                          |
| 12  | Repeated trials per case, pass^k                                                | Vercel, tau-bench                                      | Adapt later, as a report-only lens                                       | The gate's estimand needs cases, not repeats; repeats touch keys, resume and budget                                                                                        |
| 13  | pass@k                                                                          | Vercel                                                 | Skip                                                                     | Rewards the behaviour a reliability gate should catch; already rejected in an earlier note                                                                                 |
| 14  | Testing pyramid (deterministic, one-turn, end to end)                           | Vercel                                                 | Skip (already shipped as structure)                                      | Mode A is the one-turn tier, Mode B the end-to-end tier; the deterministic tier is designed but not built                                                                  |
| 15  | Verifier isolation and credential brokering                                     | Vercel                                                 | Skip (already shipped)                                                   | Sandboxes never score; the key stays outside the sandbox                                                                                                                   |
| 16  | Read passing traces, flag misleading passes                                     | Vercel                                                 | Skip (already shipped in part)                                           | The reference audit samples accepted outputs; no new mechanism needed now                                                                                                  |
| 17  | Curated edge-case and "do not act" tasks                                        | Vercel                                                 | Adapt later, flag only                                                   | Same oracle problem as row 1 unless the team supplies a verifier through `--evaluator`                                                                                     |
| 18  | Per-constraint verifier scores                                                  | Vercel                                                 | Adapt later                                                              | Useful for diagnosis; the judge returns one verdict and a justification today                                                                                              |
| 19  | Automated trace analysis with reader agents                                     | Vercel                                                 | Skip                                                                     | Not validation; a possible agent feature much later                                                                                                                        |
| 20  | Website copy                                                                    | all                                                    | No change                                                                | Nothing here is shipped                                                                                                                                                    |

## What was read, and how

Each PDF was converted to text with `pdftotext` and read as text. Figures were not seen, and
tables arrived as loose numbers. Page counts below are from the extracted text.

Read in full:

- Groce, Zhang, Eide, Chen, Regehr. "Swarm Testing". ISSTA 2012. 11 pages.
  https://users.cs.utah.edu/~regehr/papers/swarm12.pdf
- Zhou et al. "FoundationDB: A Distributed Unbundled Transactional Key Value Store". SIGMOD 2021. 14 pages, including section 4 (simulation testing) and section 6.2.
  https://www.foundationdb.org/files/fdb-paper.pdf
- O'Callahan et al. "Engineering Record And Replay For Deployability". USENIX ATC 2017 (the rr
  paper). 14 pages with the cover sheet.
  https://www.usenix.org/system/files/conference/atc17/atc17-o_callahan.pdf
- Fahmy, Selivanov. "Agents are users, so your software needs evals". Vercel blog, 2026-11-16.
  Fetched as Markdown. https://vercel.com/blog/agent-evals
- TigerBeetle. "Deterministic Simulation Testing" (VOPR design note) and the testing internals
  note. Two short Markdown files.
  https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md

Read in part:

- Groce et al. "Help, Help, I'm Being Suppressed! The Significance of Suppressors in Software
  Testing". ISSRE 2013. 10 pages. Read: the introduction, definitions, subjects, RQ1 to RQ3,
  the causes of suppression for compilers, JavaScript, HTML and the red-black tree, and
  sections V to VIII. The tables and most of RQ4 did not survive text extraction and were not
  studied.
  https://users.cs.utah.edu/~regehr/papers/issre13.pdf
- Yao, Shinn, Razavi, Narasimhan. "tau-bench". arXiv 2406.12045. 50 pages. Read: sections 1 to
  6 (the main-body prose, including the pass^k definition and estimator), without the
  appendices or figures. https://arxiv.org/abs/2406.12045
- Harbor README (first 70 lines). https://github.com/harbor-framework/harbor
- TigerBeetle safety note: searched for simulation content only.

Not read:

- Will Wilson, "Testing Distributed Systems w/ Deterministic Simulation" (Strange Loop 2014). A
  video; no transcript was found. Wilson is a co-author of the FoundationDB paper, which covers
  the same system.
- Hermit and DetTrace. Neither was obtained, so they are not cited.
- Provider API references for a `seed` parameter. The OpenAI reference returned 403 and the
  Anthropic page was truncated before the relevant part. Row 5 does not depend on them, but
  anyone who revisits it must read the current docs first.

One note on the sources:

- The Vercel post computes pass^5 as 0.6^5, about 8%, from five trials with three passes, and
  states that it assumes independent trials at a 60% rate. tau-bench's own unbiased estimator
  is C(c,k)/C(n,k), which for n = 5, c = 3, k = 5 is zero. The plug-in p^k is biased at small
  n. This matters for row 12.

## The engine as it is, in the terms these sources use

- **One trial per case per candidate.** `cellsFor` builds one cell per step, candidate and
  case (`harness/packages/replay/src/driver.ts:225-248`), keyed by
  `replayCorrelationKey(evidenceQuestionId, caseId, candidateId)` (`driver.ts:125-131`). There
  is no repeat index anywhere in `kernel/src`, `replay/src` or `rightmodeler/src`.
- **The replay request carries what was recorded.** Messages, temperature, output cap, tools,
  tool choice, response format and headers (`driver.ts:872-883`). `provider.ts` sends
  temperature and no seed (`provider.ts:30, 1000`).
- **Tool-shaped cases are not replayed in Mode A.** The plan warns that "Tool calls, non-text
  parts and tool definitions in a recorded conversation are not replayed" and leaves those
  cases out (`harness/packages/rightmodeler/src/pipeline.ts:3300-3322`).
- **Cached answers are refused.** A gateway cache hit is classified as a substitution of kind
  `cache` (`replay/src/provenance.ts:90-106`), and a substituted execution makes a Mode B run
  set incomplete instead of counting as a pass (`confirm.ts:756-759`).
- **Determinism that already exists.** The corpus seed is a constant
  (`pipeline.ts:248`) and is stored in the corpus manifest; case ids are content digests and
  the split is a seeded hash (`rightmodeler/src/data/corpus.ts`, `buildCorpus`;
  `kernel/src/selection.ts`, `assignSplits`); bootstrap resampling uses a seeded generator with
  a seed derived from the evidence question (`kernel/src/statistics.ts`, `clusterBootstrap`;
  `kernel/src/aggregation.ts:509-516`); the judge runs at temperature 0
  (`kernel/src/judge.ts:16, 267`); each attempt records the served model, provider response
  id, finish reason and latency (`harness/packages/core/src/facts.ts:53-76`); finished calls
  are reused on rerun.
- **Mode B swap sets are per family.** `executeConfirm` loops over the families that need
  confirmation, takes `plan.steps` whose family is that family, and moves them all to that
  family's selected candidate (`pipeline.ts:4749-4777, 4822-4832`), then calls
  `confirmSwapSet`. An approved swap set, by contrast, can hold several families, each with
  its own target model (`pipeline.ts:3968-3976`). That function runs the full set first; only a
  first-run pass is "confirmed" (`replay/src/confirm.ts:944-955`). On failure, `deltaDebug`
  enumerates subsets by increasing size, starting with the empty set, and returns
  "inconclusive" if the empty set fails (`kernel/src/ddmin.ts`). The empty set is a control
  run with no swaps. Mode A has no equivalent.
- **Mode B runs the team's app live.** A confirmation case carries only the first recorded
  input and the final recorded output of a trajectory (`pipeline.ts:5086-5133`); no recorded
  per-step outputs are served. Steps that are not swapped call their current model for
  real. The in-sandbox proxy handles only requests that carry `x-rm-step` and `x-rm-call`
  (`replay/src/proxy/proxy-runtime.mjs:626-650`), which are model calls. The container
  receives run, case and execution ids and proxy settings (`replay/src/driver-modeb.ts:510-530`)
  and no recorded timestamp. On the cloud backend the firewall "lets every other host through"
  (`harness/packages/rightmodeler/docs/modeb.md`), and on the Docker backend the container
  runs with Docker's default networking (`harness/packages/executor/src/index.ts`, the
  `docker run` arguments), so the app keeps ordinary network access on both. Lost, failed and silent-failure executions
  count as failed observations (`confirm.ts:752-772`).

## Statistics: what the gate estimates and what these methods would do to it

The gate estimates theta, the mean probability that a candidate's answer is judged equivalent
to the accepted output, over the distinct recorded inputs of a family. Each case contributes one
Bernoulli draw with its own success probability p_i. One draw per case is enough: the draws are
marginally Bernoulli(theta), so the Wilson bound is valid, and the trajectory bootstrap handles
cases that share a trajectory. The variance of the estimate is
(between-case variance + mean within-case variance / K) / N for N cases and K repeats. Repeats
shrink only the second term. When cases are available, a new case is always worth more than a
repeat, and when cases are scarce, repeats cannot substitute for them. This is the same lesson
as the swarm paper's central result: diversity across configurations beats repetition within
one.

Swarm testing changes the test distribution on purpose. The paper says so directly: the
reachable test space is unchanged and only the probabilities move. A pass rate over swarm-built
cases estimates agreement under a distribution that is not production traffic. It cannot be
reweighted back, because a recorded case with a tool removed has probability zero in traffic.
So swarm cases can never be pooled into the bound.

Could they be a separate lens that only blocks? Two obstacles.

1. **No oracle.** Csmith's oracle is "the compiler crashed". FoundationDB's is assertions and
   workload invariants. TigerBeetle's is thousands of assertions plus state checkers. rightmodeler has no invariant of
   that kind. A differential run against the incumbent on the mutated input would cost
   incumbent-price calls and would measure agreement with an output nobody accepted.
2. **No noise floor.** A lens that blocks on any failure over m cases, with a per-case
   false-failure rate e from judge and sampling noise, blocks a good swap with probability
   1 - (1 - e)^m. rightmodeler does not measure e today. Until it does (row 11), any block-only
   lens would raise false rejections by an unknown amount.

So the order of work matters: a control measurement comes before any stress lens.

On pass^k: by Jensen's inequality the mean over cases of p_i^k is at least theta^k. A family
that clears a 0.85 lower bound therefore has an implied lower bound of 0.85^5, about 0.44, on
five consecutive agreeing calls, with no extra model calls. That number is honest and
unflattering, and it is the reason steps that feed later model steps go to Mode B instead of
borrowing a single-step number. Printing it is not recommended: it is a bound on a quantity
nobody set a floor for.

## Swarm testing

**What the paper claims.** Omitting features at random per configuration finds more distinct
faults than one inclusive configuration at equal budget: 104 against 73 distinct compiler
crashes in a week, with fewer total crashes. Features suppress faults actively (pop prevents
overflow) and passively (they crowd out the calls that matter). The same feature is often a
top trigger and a top suppressor, so no single configuration is best. The authors name a
weakness: a swarm lowers the chance of any bug that needs many features together, and the
simple mitigation is to "include C_D in every swarm set". The follow-up paper adds that
suppression is as common as triggering, that causes are idiosyncratic and hard to predict, and
that fault masking (a common failure hiding rarer ones) is a major cause.

**Row 1, case construction: skip.** The oracle argument above. Two further facts. First, the
features one would toggle (tools, tool turns, structured output) are the ones Mode A already
cannot replay (`pipeline.ts:3300-3322`), so the swarm would operate on the narrowest part of
the input. Second, a swarm needs a generator, `gen(C, s)`; rightmodeler has recorded inputs,
not a generator, and deleting parts of a real conversation produces inputs the app never sends.

**Row 2, analysis without new calls: adapt later.** The transferable part of the paper is its
analysis, not its generator: for each failure, compute a Wilson interval for the share of
failing cases that contain each feature, and compare it with the base rate. Applied to the
existing representative sample (context length band, system prompt present, multi-turn,
response format), this would tell a reviewer where a candidate fails. FoundationDB's coverage
macros are the same idea from the other side: count how many runs reached a condition. It
costs no model calls. It is deferred because the paper needed at least four failures per
target to say anything, a family's sample can be as small as the gate minimums (22 held-out
cases at the default floor), and unadjusted slices at that size
would mislead. It becomes worthwhile when the report can pool many runs.

**Row 3, swarm over the swap set: skip.** The swarm coverage formula, 1 - (1 - 0.5^k)^n,
matters when k is large and the full configuration is one choice among many. Here the full set
is the thing that will merge, it is run first, and after a failure the subsets are enumerated
exhaustively by size. Random subsets would add cost and say nothing about the full set.

**Row 4, joint confirmation: adapt later.** This is the real lesson of the swarm paper for
Mode B, and it points the other way from row 3. Faults often need features in combination. A
swap set is one family; if two families clear their gates in one run, each was confirmed with
the other family's steps still on the current model. Their combination was never run, yet an
approved swap set can contain both (`pipeline.ts:3968-3976`). `apply` was not read for this memo, so how often a multi-family set is opened as one pull
request in practice is unknown. The fix would be one extra run set with every recommended family swapped at once,
before `apply`. It needs design, because a joint failure has to be attributed.

## Deterministic simulation testing

**What the sources claim.** FoundationDB runs the real database in a single-process
discrete-event simulation where network, disk, time and the random number generator are all
abstracted, so a seed reproduces any failure. TigerBeetle states the same contract: seed plus
commit hash replays the exact run. Both pair simulation with fault injection and assertions.
The FoundationDB paper is explicit about limits: simulation "is not able to reliably detect
performance issues" and is "unable to test third-party libraries or dependencies", which is why
the team removed external dependencies. It also warns that fault rates are "carefully tuned to
avoid driving the system into a small state-space". The rr paper gives the general rule:
"identify a boundary around state and computation, record all sources of nondeterminism within
the boundary and all inputs crossing into the boundary", then re-execute.

**How that maps.** For rightmodeler the system under test is a third-party model, which is the
case the FoundationDB authors say simulation cannot cover. The rr rule still applies, and
rightmodeler already follows it: the recorded trace is the recording, the model call is the
boundary, and Mode A re-executes one step with recorded inputs. What can be deterministic already is
(row 9). What cannot be is the candidate's sampling.

**Row 5a, provider seeds: skip.** Current provider behaviour was not verified, and the design
should not depend on it. tau-bench ran its agents at temperature 0 and still measured pass^8
below 25% on tasks with over 60% average success, although part of that variance came from a
simulated user at temperature 1. The honest position for evidence is the one already taken:
store the candidate's actual output and the judge's verdict, which reproduces the finding
without re-running the model.

**Row 5b, forced temperature: skip.** Replays send the recorded temperature
(`driver.ts:876`). A swap pull request changes only model identifiers, so the app will keep
its own temperature after merge. Replaying at 0 would give a tidier number for a configuration
that does not ship.

**Row 5c, caching recorded responses: skip for candidates, adapt later for the Mode B
prefix.** A cached candidate answer is someone else's answer; the engine already treats a
cache hit as a substitution and will not count it. The rr idea does apply in one place. In
Mode B, steps that run before the first swapped step see the same inputs as in the recording,
so their recorded outputs could be served by the proxy instead of paying the current model to
regenerate them. That would remove one source of noise and some cost. It needs recorded
per-step outputs in the case file and an exact-match rule for requests, and it must fall back
to a live call on any mismatch, so it is design work, not a quick change.

**Row 6, deterministic Mode B environment: adopt now, as documentation.** In Mode B the
boundary leaks. The app's clock, its outbound tool calls and its non-swapped model steps all
run live, and the recorded final output came from a different day. Any drift from those
sources is counted as a failed case, which pushes families toward "isolated" or "inconclusive"
for reasons unrelated to the swap. The Vercel post's
`SFBEANS_NOW` frozen clock and seeded `cafes.json` and FoundationDB's abstracted time are the
same advice. rightmodeler cannot do this for the team, but it can say so. Plan below.

**Row 7, fault injection: skip.** The proxy sees model calls only, so it cannot inject a tool
timeout. Injecting 5xx or latency on model calls tests the app's retry and timeout code, which
is the same code for either model. The one model-dependent effect is latency (a slower
candidate may trip an app timeout), and positioning already says latency is not gated. And
there is no accepted output for a faulted run. If a team wants this, the route is their own
evaluator, not a built-in lens.

**Row 8, virtual clock: skip.** FoundationDB gains speed because simulated time skips idle
waits. A replay's wall time is model latency, which is real and paid.

**Row 10, DST for the harness itself: adapt later.** The method does apply to rightmodeler's
own deterministic code: budget leases, checkpoint resume, the confirm plan, the adaptive
concurrency controller. A seeded fake provider that injects 429, 5xx, dropped streams and
process kills, with invariants such as "ledger never exceeds the authorized total" and "a
resumed run reaches the same verdict", is a FoundationDB-style test. The seeded generator
already exists in `statistics.ts`. This is engineering quality work with no product surface.

## The Vercel post on agent evals

**What it claims.** An eval is a test run many times and scored. Tests form a pyramid by model
calls: deterministic (0), one-turn (1), end to end (2 or more). Choose the metric by what a
failure costs: success rate, pass@k ("can it at all") or pass^k ("every time"). Build tasks
with an instruction, a seeded environment, a verifier scored per constraint and a known-good
solution that is run first "to prove the task works". Protect the verifier and seed data from
the agent. Read traces, including passes: in their demo nine of ten passes on one task were the
agent giving up, which the verifier counted as success. "With only five trials, 100% means no
failures seen yet."

**Where it agrees with rightmodeler as built.**

- The pyramid is the Mode A and Mode B split, with the same reasoning: each step "can look
  reasonable on its own, and the agent can still get the wrong outcome" is why a step that
  feeds later model steps is routed to confirmation (Architecture section 7, "Mode A optimism
  is an abstention trigger").
- "No failures seen yet" is the all-pass Wilson minimum: 22 held-out cases at a 0.85 floor
  (`statistics.ts`, `minimumTrialsForFloor`).
- Verifier isolation is "Sandboxes never score" (Architecture section 6), and credential
  brokering is how the cloud backend already handles the model key (`modeb.md`).
- Misleading passes are the known limit of agreement with accepted outputs, which the
  reference audit exists to measure.
- Per-task results over averages is the per-family verdict.

**Where it conflicts with the other two sources.**

- Vercel and tau-bench favour a small curated task set run many times; tau-bench says it
  trades "quantity for quality". The swarm paper says diversity beats repetition. For
  estimating a rate on real traffic the swarm side is right, and it is what the engine does.
- DST promises exact reproduction from a seed. Vercel accepts that "LLM outputs vary between
  runs" and measures the variation. For a model call the Vercel position is the correct one.
  The two agree on the environment: freeze the clock and seed the data.
- Vercel's task set deliberately includes edge cases and a "do not act" case. That is
  bug-finding sampling, like swarm, and has the same standing here: it can inform, and it
  cannot enter the bound (row 17). It differs from swarm in one useful way: the team writes a
  verifier, so there is an oracle. `--evaluator` is the existing door for that.

**Row 11, incumbent control replay: adapt next.** The post's known-good solution and the empty-set run in `deltaDebug` are one idea: before
trusting a failure, show that the known-good configuration passes. Mode A has no such run. A
team that sees "inconclusive, lower bound 0.81" cannot tell whether the candidate is worse or
whether the incumbent itself, replayed today and graded by the same judge, would agree with its
own accepted outputs only 88% of the time. That self-agreement rate is the ceiling of what any
candidate can score, and it is the e in the false-rejection formula above. Design below.

**Row 12, repeats and pass^k: adapt later.** It measures something real that K = 1 cannot see,
and the earlier research note already reached that view and warned about small-K bias (the
plug-in p^k problem noted above is the same warning). But repeats are not small: the
correlation key has no repeat index, so resume, budget reservation and the aggregation's
clustering would all change. If built, it is a report-only lens on a seeded subsample, uses
the tau-bench estimator, clusters repeats by case, and never feeds the gate.

**Row 13, pass@k: skip.** A swap ships one pinned model that answers once. pass@k moves the
opposite way to consistency. The earlier note rejected it for the same reason.

## Adopt now: Mode B environment guidance (documentation only)

**Change.** Add a section "Keep the environment the same for every case" to
`harness/packages/rightmodeler/docs/modeb.md`, after "Runtime contract". Content, in plain
terms:

- Mode B compares the app's final output today with the output recorded earlier. Steps that
  are not swapped call their current model live, and the app's clock and any outbound calls
  its network allows are live too.
- Anything that changes between the recording and the run, other than the swapped model, shows
  up as a failed case and can turn a family into "isolated" or "inconclusive".
- Recommendations for the image: take the current time from a fixed value the driver sets
  instead of the system clock (the case file holds only `caseId`, `input` and `headers`, so
  it carries no timestamp); serve tool and retrieval calls from fixtures or a snapshot; seed
  any randomness; avoid writes to shared external state.
- How to recognise the problem: a confirmation that fails with every swap removed is reported
  as "inconclusive", which points at the environment, not the candidate.

**Not changed.** No CLI flag, no data shape, no evidence field, no gate.
`scripts/generate-docs.mjs` writes only `docs/commands.md`, so `modeb.md` is hand-written and
`commands.md` is untouched. The skill references under
`skills/rightmodeler/reference/harnesses/` already tell the agent to replace side-effecting
tools with trace-backed results and never fall through to the live side effect, which is
consistent with this guidance, so they need no change.

**Bundle.** `build.mjs` copies `docs/` into the published package (line 154) and
`package.json` lists `docs` in `files`, so the text ships with the next publish. The committed
`dist-bundle` holds built code; run `pnpm --filter @rightmodeler/cli bundle` and expect no
diff there. Run `pnpm format` and `pnpm check`.

**Tests.** None needed. The last bullet rests on `kernel/src/ddmin.ts:83-96` (after a
full-set failure the empty subset runs first, and a failing empty subset returns
"inconclusive") and `replay/src/confirm.ts:949-955` (the mapping to the confirmation
verdict). It has not been observed on a real failing run.

**Effort.** Half a day including review.

## Adapt next: incumbent control replay (design sketch, not yet a plan of record)

This is not marked "adopt now" because one safety property is unverified, and getting it
wrong would weaken a shipped gate.

**The risk.** In `executeReplay`, shortlist verdicts are filtered by family and passed whole to
`selectWinner` (`pipeline.ts:4253-4281`), and `selectWinner` uses the number of candidates as
the Bonferroni comparison count. Control executions written as ordinary facts with the family's
evidence question would appear as one more candidate. That would change the multiplicity
correction and could let the incumbent "win". The control must be invisible to aggregation.

**Spike, one day.** Confirm that executions written under a distinct evidence question id and a
`selectionStage` of `control` are excluded by `materializeAggregationFacts`, by
`replayFactState` resume logic, by `apply`'s evidence checks and by the run spec digest that
`apply` and the approved-regression schedule compare. If any of these read facts by run alone,
the control needs its own namespace.

**Shape if the spike passes.**

- Flag: `--control-sample <n>` on the commands that replay. Default 0 (off). It spends
  incumbent-price calls, so it must be opt-in and counted against `--max-cost-usd`.
- Cases: the first n shortlist-half cases per family in split-hash order, so the choice is
  deterministic and uses no held-out case.
- Execution: one `replayModeA` call per family with the family's current model as the only
  "candidate", same recorded request, same judge selection rule. The judge must still be from
  a family other than the incumbent's, which the existing rule gives.
- Evidence: a per-family object `control: { model, cases, passes, lowerBound, upperBound,
method }`, reported beside the existing reference ceiling and, like it, entering "no bound
  and no gate" (Architecture section 7).
- Report: one line per family, for example "Control: the current model agreed with its own
  accepted outputs on 27 of 30 cases (95% interval 0.74 to 0.97)". A warning when the control's
  upper bound is below the quality floor, because the floor is then unreachable for any
  candidate under this judge.
- Rules: the control never passes, blocks or rescues a swap. No relative gate ("within x of
  the incumbent") is introduced.
- Tests: control facts do not change any family verdict, selection or comparison count
  (compare a run with and without the flag on a fixture); resume reuses control calls; the
  spend cap stops the control before the candidates, not after; the report prints the line
  and the warning.
- Docs and bundle: new flag means regenerating `docs/commands.md` and rebuilding the committed
  `dist-bundle`; add a paragraph to the packaged docs and the skill reference.
- Effort: about five to seven working days after the spike.

**Why it is worth doing.** It is the prerequisite for every other lens in this memo (the
false-rejection formula needs e), it explains "inconclusive" results to users, and it is the
only item here that makes the existing claim more honest instead of adding a new one.

## Website copy

No change. Nothing in this memo is shipped, and the documentation change in row 6 is not a
product claim.

- Do not add "simulation", "deterministic", "stress test", "fault injection", "noise floor" or
  "pass^k" to any page. None is in the positioning vocabulary and none describes shipped
  behaviour.
- Do not describe replays as reproducible or deterministic. Evidence is stored and re-read;
  model calls are not reproduced.
- No roadmap sentence is recommended either. If one is wanted after the control ships, it belongs
  on the how-it-works page (`apps/web/src/content/pages/how-it-works.ts`) next to the
  description of the judge, in shipped tense, and `docs/positioning.md` must gain the wording
  in the same pull request. That file was not opened, so the exact insertion point needs
  checking then.
- For the narrative, the Vercel post is useful as independent agreement with things already
  true of rightmodeler: one-step and end-to-end validation are different tiers, a handful of
  passing trials is not evidence, and the sandbox must not grade itself. A blog post could say
  that with a citation. It should not borrow pass^k figures.

## Bibliography

1. A. Groce, C. Zhang, E. Eide, Y. Chen, J. Regehr. Swarm Testing. ISSTA 2012.
   https://users.cs.utah.edu/~regehr/papers/swarm12.pdf
2. A. Groce, C. Zhang, M. A. Alipour, E. Eide, Y. Chen, J. Regehr. Help, Help, I'm Being
   Suppressed! The Significance of Suppressors in Software Testing. ISSRE 2013.
   https://users.cs.utah.edu/~regehr/papers/issre13.pdf
3. J. Zhou et al. FoundationDB: A Distributed Unbundled Transactional Key Value Store. SIGMOD 2021. https://www.foundationdb.org/files/fdb-paper.pdf
4. R. O'Callahan, C. Jones, N. Froyd, K. Huey, A. Noll, N. Partush. Engineering Record And
   Replay For Deployability. USENIX ATC 2017.
   https://www.usenix.org/system/files/conference/atc17/atc17-o_callahan.pdf
5. TigerBeetle. Deterministic Simulation Testing (VOPR), and testing internals.
   https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md
   https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/testing.md
6. G. Fahmy, Y. Selivanov. Agents are users, so your software needs evals. Vercel, 2026-11-16.
   https://vercel.com/blog/agent-evals
7. S. Yao, N. Shinn, P. Razavi, K. Narasimhan. tau-bench: A Benchmark for Tool-Agent-User
   Interaction in Real-World Domains. arXiv 2406.12045, 2024. https://arxiv.org/abs/2406.12045
8. Harbor framework README. https://github.com/harbor-framework/harbor
9. Internal: `docs/positioning.md`, `harness/docs/Architecture.md` (sections 6 to 10),
   `docs/research/model-substitution-evidence-research.md` (section 1),
   `docs/research/eval-scorecards-release-gates.md` (replay suite paragraph), and the engine
   files cited inline.
