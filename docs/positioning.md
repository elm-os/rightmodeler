# Positioning

How rightmodeler describes itself: the thesis, what is true today, the words we use and the
claims we never make. Read it before writing copy anywhere: the site, the READMEs, the packaged
docs, the skill, package descriptions and repository metadata. [design.md](design.md) covers
how things look; this covers what they say. When copy and this file disagree, fix the copy or
change this file in the same pull request.

## The thesis

We think the biggest bottleneck in maintaining software is the human in the loop: not the
judgment, the work. We are solving it first for production AI systems, where a new model ships
every few weeks and each one restarts the same manual job: notice it, pull real traces, build a
replay, grade the outputs, write it up so it survives review, migrate, and do it again.

The shortcuts teams take instead do not hold up:

1. **Blind swaps fail quietly.** A cheaper model drops into a step in thirty seconds. When it
   fails, nothing throws: the JSON still parses and is wrong on the edge cases.
2. **Routers don't work in production.** Our opinion, for three reasons: a runtime router picks
   a model per request with a policy that was not validated on your workload; it adds a hop and
   a dependency to the request path; and the same input can take different models, so behavior
   is harder to reproduce, audit and roll back. A gateway that serves the model you pin is a
   different thing.
3. **General benchmarks aren't your workload.** A leaderboard ranks models on someone else's
   tasks. It cannot tell you whether a cheaper model matches the outputs you already accepted.
4. **Frontier everywhere costs too much.** The most expensive model on every step feels safe
   until the bill compounds, call by call, on steps nobody has measured.

What holds up: one pinned model per step, validated on your own traces and changed through code
review.

The mission is autonomous self-maintenance and optimization of production AI systems. It always
reads as a direction: "toward production AI that maintains itself", "software should maintain
itself". Never describe rightmodeler as autonomous or self-maintaining in the present tense.

## What rightmodeler is today

A validation framework for model swaps: it validates swaps to cheaper or newer models on your
production traces and opens each one that clears every release gate as a draft pull request.

The positioning says rightmodeler validates "cheaper or newer" models. Newer means a newer model
at the same price or cheaper, or faster, or smarter. The CLI today tests only models that cost
less than the recorded one and ranks newer ones first; support for the rest ships in a later
release. Text that states the mechanism (the shortlist price filter, `--candidate` models that
cost less, refusal reasons, estimates, gates) stays exact and keeps "cheaper".

- **rightmodeler CLI** (on npm as `rightmodeler`, MIT). Reads the model calls your app already
  recorded, replays the recorded steps on cheaper candidate models from your provider's live
  catalog (by default up to three released in the last 90 days, or models you name with
  `--candidate` that cost less), and has a judge from a different vendor, or your own evaluator,
  grade every answer against the output you accepted. Replay sends recorded text conversations:
  cases whose conversation carries tool calls, tool definitions or non-text parts are left out of
  the replay sample today, and the run says how many. A swap that clears every gate becomes a draft pull request
  that changes only model identifiers, with the evidence attached. `watch` follows the pull
  request through review and CI; `rollback` opens a pull request that restores the exact
  pre-swap files. A coding-agent skill drives the same CLI.
- **rightmodeler agent** (same repository, self-hosted today; the hosted version has a
  waitlist). The maintenance loop, on a schedule: a weekly catalog and price check that flags
  cheaper new or repriced models, a daily drift check on new traces whose proposals a person
  approves, one regression replay for each merged swap set, and follow-up on swap pull requests
  as review and CI report back. On your word it replays new candidates; once a replay clears
  every gate, it opens the draft pull request. It never merges and carries no merge capability.
- **Crucible** (open source under the MIT license at
  [github.com/elm-os/crucible](https://github.com/elm-os/crucible)). Open-source, self-hosted
  observability and analytics for AI agents and MCP servers, built in Rust and engineered for speed
  and throughput. It is a released product: write about it in the present tense, and describe only
  what Crucible's main branch does. Ruling 6 covers the rest.
  - Three ways to use it: agents only; MCP servers only; or both, with an agent's tool calls
    linked to the server-side MCP spans through trace context.
  - One Rust binary that ingests OpenTelemetry traces (OTLP over HTTP and gRPC) and serves a web
    UI, a REST API and an MCP server that coding agents query. Telemetry is stored in a single-node
    ClickHouse (26.3 or newer); Postgres (15 or newer) is the control plane. It runs in Docker with a
    bundled ClickHouse and Postgres, from the published image, or as a binary installed from the
    GitHub release; durability holds on Linux and macOS, and the Windows binary is for development.
  - Instrumentation: OTLP from any OpenTelemetry SDK; spans from OpenInference, OpenLLMetry, the
    Vercel AI SDK, MLflow and Pydantic AI, mapped as they arrive; SDKs for TypeScript, Python, Go
    and Rust (agent helpers plus an MCP server wrapper, in the repository); and a proxy that records
    an MCP server's calls with no code changes and forwards its traffic unchanged.
  - What it does: traces, spans, sessions and users, with a timeline and an agent graph; cost,
    tokens and latency, with dashboards to chart them; full-text search; MCP call records; MCP
    analytics (servers, tools, errors, clients, users, sessions, operations, deploys and deploy
    comparison, for the server or the client side, with p50, p90 and p99 latency and caller faults
    counted apart, and analytics tools on its MCP server); alerts on span and MCP call measures (MCP
    calls, error rate, error count and latency percentiles) to Slack, email and signed webhooks; a
    read-only SQL workspace isolated by ClickHouse; exports; retention and deletion requests;
    optional media storage (images, audio, video and files on S3-compatible object storage, inline
    without it); organizations, projects, roles and API keys.
  - How it is built, as mechanisms: a span is acknowledged only after it is written to a write-ahead
    log and synced; each batch reaches ClickHouse with a deduplication token, so a retry never
    stores a span twice; under load it answers 429 or 503 with Retry-After. It is tested with
    deterministic simulation, swarm testing, a formal model of the ingest protocol and proofs of
    the log format.
  - With rightmodeler: crucible export writes OpenTelemetry JSON that the rightmodeler CLI replays
    to validate cheaper or newer models, and coding agents ask Crucible about their runs over its
    MCP server.

The CLI and the agent run offline, beside your app, on your machine or in CI. Neither sits in
the request path, and there is no rightmodeler server and no telemetry. Crucible is different by
design: it is a server you host that receives your telemetry, with an opt-in proxy in front of an
MCP server.

"Production traces" means the model calls your production app recorded (tracing platforms,
OpenTelemetry, gateway logs). When `init` picks up Claude Code or Codex sessions on disk, or a
file you point it at, say "the traces you already have", not "production traces".

### What safe means

Reuse this sentence verbatim wherever "safe" is defined:

> A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces:
> agreement with the outputs you accepted, at a statistical lower bound that reaches your quality
> floor on held-out cases, with swaps that feed later model steps confirmed end to end in a
> sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness,
> and abstains when the evidence is thin.

The shortlist half only screens candidates (each evaluator's pass rate must reach 0.75); the
lower-bound test against the floor runs on the held-out half, adjusted for the number of
candidates. So never write that a candidate clears the floor "again" on held-out cases.

### What a person still does today

A person sets the policy (the quality floor, which models are allowed, an optional spend cap),
gives the agent the word before it replays a new candidate, and decides whether each draft pull
request merges. Rolling back is one command that opens another pull request. That is deliberate:
autonomy is earned with evidence, and validation is how rightmodeler earns it. The direction is a
system that maintains itself inside the policy you set, reached one validated change at a time.

Write it as "rightmodeler takes the work out of the loop, not the judgment" and "today, the
final yes stays yours". Avoid absolutes about the agent: a watch pass can close a swap pull
request whose CI failure repeats, and each merged swap set gets one regression replay without a
fresh word.

## Rulings

1. **The human in the loop.** The bottleneck is the work, never the person. Never imply that
   rightmodeler merges, deploys or swaps anything on its own.
2. **Production.** rightmodeler is built for production AI systems and validates on production
   traces, the calls your app already recorded. It never runs in production, in production
   traffic or in the request path. End-to-end confirmation runs your app in a sandbox (a Docker
   container or a Vercel Sandbox microVM), apart from your production deployment. The sandbox keeps
   your model key out but has ordinary network access, so wherever copy says rightmodeler does not
   touch production, the end-to-end case adds that your app's tools should point at test fixtures,
   not production services. Say "a sandbox", not "an isolated sandbox".
3. **Routers.** "Routers don't work in production" is our opinion and always carries its
   reasons. It appears on the home page, the manifesto, the vision posts and llms.txt, never
   naming a product. Comparison pages, integration pages, comparison posts and case studies stay
   factual: a router chooses a model per request at runtime; rightmodeler validates one pinned
   model per step, offline, before a person merges. Gateways are replay endpoints; never call
   them routers. Attributed quotes keep their words, including "precision routing".
4. **Safe.** Safe is the sentence above, never a guarantee. Strings that travel alone (the
   one-liner, meta titles, card footers, alt text) say "validated", not a bare "safe".
5. **Scope.** Candidates must cost less than the recorded model, even when named. Every string
   that says what gets validated says "cheaper or newer": the one-liner, meta title and
   description, card footer, organization description and llms summary. Support for newer models
   that do not cost less ships in a later release; until then, mechanism text keeps "cheaper".
6. **Crucible.** Describe Crucible on its own terms, as a released product, in the present tense:
   never "in development", "planned", "coming soon", "being built" or "preview", and never a
   waitlist. Claim only what Crucible's main branch does; leave out what it does not do yet rather
   than labelling it planned, and add it when it ships. It is self-hosted only: no hosted service,
   pricing, performance numbers or customers. "Built in Rust and engineered for speed and
   throughput" is the speed claim; back it with mechanisms, never with numbers or comparisons.
   Never compare it with other products, and never say or imply that it was copied from, based
   on, ported from or a remake of anything. Its call to action is the GitHub repository and the
   quickstart, never a sign-up. Durability and correctness are mechanisms and tests, never
   guarantees. The rightmodeler link runs one way: rightmodeler replays Crucible traces, and
   Crucible does not run the validation loop or swap models. What this file says about the CLI and
   the agent (offline, never in the request path, no server, no telemetry, no simulation) does not
   describe Crucible.

## Canonical strings

| Surface                                               | Text                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home eyebrow                                          | Toward production AI that maintains itself                                                                                                                                                                                                                                       |
| Home h1                                               | The human in the loop is the bottleneck.                                                                                                                                                                                                                                         |
| Home subhead                                          | rightmodeler takes the work out of the loop, not the judgment. It validates cheaper or newer models on your production traces against the outputs you accepted, and opens a draft pull request only when a swap clears every gate. Today, the final yes stays yours.             |
| Home meta title                                       | rightmodeler: cheaper or newer model swaps, validated on your traces                                                                                                                                                                                                             |
| Home meta description                                 | The bottleneck is the human work in the loop. rightmodeler validates cheaper or newer models on your traces and opens a draft pull request for your review.                                                                                                                      |
| One-liner (GitHub, npm and root package descriptions) | Cheaper or newer model swaps for production AI, validated on your own traces and opened as draft PRs.                                                                                                                                                                            |
| Organization description                              | rightmodeler is working toward production AI systems that maintain and optimize themselves, starting with an open-source framework that validates swaps to cheaper or newer models on your own traces and opens each one that clears every release gate as a draft pull request. |
| Home thesis section                                   | Eyebrow "Why model swaps stall", h2 "Model maintenance is a standing job.", the four failures above as h3s                                                                                                                                                                       |
| Home thesis closer                                    | The safe sentence, or the short form "A swap is safe when it clears every release gate on your own traces." with a link to /how-it-works, where the full sentence appears. It is the one exception to reusing the safe sentence verbatim.                                        |
| Home platform section                                 | Eyebrow "From validation to autonomy", h2 "It starts with safe model swaps." (directly under the thesis section, whose closer defines safe)                                                                                                                                      |
| Home CTA band                                         | Start with the traces you already have.                                                                                                                                                                                                                                          |
| Hero ledger label                                     | rightmodeler · per-step swap validation                                                                                                                                                                                                                                          |
| Manifesto h1                                          | Software should maintain itself.                                                                                                                                                                                                                                                 |
| Agent page h1                                         | Stop re-checking models by hand.                                                                                                                                                                                                                                                 |
| Crucible page h1                                      | Crucible: open-source observability for AI agents and MCP servers.                                                                                                                                                                                                               |
| Crucible one-liner                                    | Open-source, self-hosted observability and analytics for AI agents and MCP servers.                                                                                                                                                                                              |
| About subhead                                         | Working toward production AI that maintains and optimizes itself, starting with validated model swaps.                                                                                                                                                                           |
| Mission                                               | Production AI systems that maintain and optimize themselves, earning each step of autonomy with evidence.                                                                                                                                                                        |
| Social card footer                                    | Cheaper or newer model swaps, validated on your traces.                                                                                                                                                                                                                          |
| Default social card headline                          | Take the work out of the loop.                                                                                                                                                                                                                                                   |
| Default social preview alt text                       | Take the work out of the loop: rightmodeler                                                                                                                                                                                                                                      |
| Repository topics and npm keywords                    | ai-agents, agent-evals, llm-evals, llm-as-a-judge, model-validation, cost-optimization, llmops, traces, production-ai, regression-testing                                                                                                                                        |

The hero h1 is an opinion. It never travels without the subhead, and it is never reused as a
post title, a card or a meta title.

## Words

Use: the work in the loop; takes the work out of the loop, not the judgment; the final yes;
validate, validation, validation framework for model swaps; release gate, quality floor,
statistical lower bound, held-out cases; abstain; cheaper or newer candidate models; a judge from a
different vendor, or your own evaluator; agreement with the outputs you accepted; draft pull
request that changes only model identifiers; production traces; offline, never in the request
path; confirmed end to end in a sandbox; one pinned model per step; the maintenance
loop, on a schedule (the agent); on your word (the agent, for new candidates).

For Crucible: open-source, self-hosted observability and analytics for AI agents and MCP
servers; built in Rust and engineered for speed and throughput; agents only, MCP servers only, or
both; Crucible on GitHub; the quickstart.

| Retire                                                       | Use instead                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Right Modeler, Rightmodeler (in prose)                       | rightmodeler, always lowercase                                                |
| prove, proof, proven                                         | validate, evidence, measured                                                  |
| proof loop, proof engine                                     | validation loop, validation engine                                            |
| evidence-backed model downgrading (as a category)            | validated model swaps, swap validation                                        |
| downgrade                                                    | a swap to a cheaper model (the glossary keeps "model downgrade" as a synonym) |
| the audit, run the audit (as the CLI's name)                 | the validation framework, a validation run                                    |
| autopilot, autonomous agent (present tense)                  | the agent, the maintenance loop, on a schedule                                |
| ship, ship approved swaps (what rightmodeler does)           | open a draft pull request for each swap that clears every gate                |
| reverses, undo, every swap is reversible                     | one command opens the pull request that restores the exact pre-swap files     |
| watches approved swaps for drift                             | regression-tests each merged swap set once; watches new traces for drift      |
| watches every release                                        | rechecks the catalog weekly for cheaper new or repriced models                |
| continuous with Crucible next                                | the self-hosted agent runs on a schedule today                                |
| analytics and optimization suite (Crucible)                  | self-hosted observability and analytics for AI agents and MCP servers         |
| cost per layer, speed per step, failures as they happen      | the list above (cost and latency, MCP call records, alerts)                   |
| connected over MCP, no new SDK (Crucible)                    | ingests OpenTelemetry; agents query it over its MCP server                    |
| never in the request path (Crucible)                         | name the opt-in proxy, which sits in front of an MCP server                   |
| continuously right-sized, runs the validation loop           | rightmodeler replays Crucible traces to validate cheaper or newer models      |
| Crucible will add the instruments                            | Crucible, open-source observability for AI agents and MCP servers             |
| Crucible waitlist, join the waitlist (Crucible)              | Crucible on GitHub, and the quickstart                                        |
| in development, planned, coming soon, being built (Crucible) | the present tense, for what Crucible's main branch does                       |
| Mode B (in marketing copy)                                   | confirmed end to end in a sandbox (CLI docs keep "Mode B")                    |
| benchmarks (bare, as the failure)                            | general benchmarks, public leaderboards                                       |
| precision routing, routing policy (in our own voice)         | per-workload model assignments (quotes and case-study facts stay verbatim)    |
| multi-agent LLM systems (as the audience), the model layer   | production AI systems                                                         |
| medium confidence, confidence tiers                          | a statistical lower bound (there are no confidence tiers)                     |
| every model swap, any new model, migrations in general       | swaps to cheaper or newer models                                              |
| guaranteed, proven correct, zero risk, always safe           | cleared every release gate; agreement with what you shipped                   |

## Claims we never make

- That it merges, deploys, changes production or swaps models on its own, or that it is fully
  autonomous today.
- That it routes traffic, is a router or produces a routing policy.
- That it proves correctness or guarantees quality.
- That it runs on, watches or shadows live production traffic.
- That candidate ranking reflects your own token mix, or that savings are measured after merge.
- Latency budgets, or latency compared with the current model: the evidence reports only the
  winning candidate's p50 latency.
- That it detects unsafe substitutions, or that it has confidence tiers.
- Automatic rollback, or continuous re-validation of approved swaps.
- Policy settings beyond the quality floor, shortlist size, model allow and deny lists, an
  optional spend cap and the evaluator choice.
- That the hosted agent is available or in early access.
- That Crucible is in development, a preview, planned or coming soon.
- Crucible features its main branch does not have: ClickHouse Cloud or clustered ClickHouse,
  OTLP logs or metrics, or registry packages. Add each when it ships.
- Crucible performance numbers, including how fast MCP analytics answers over long windows,
  customers or pricing, a hosted Crucible, a comparison of Crucible with other products, or that
  Crucible was copied from, based on or remade from anything.
- That it tunes reasoning effort, prompts or retries.
- That replay covers tool calls or tool definitions, or that it validates "with your tools": recorded
  conversations with tool calls are left out of the replay sample today.
- That rightmodeler runs are deterministic or reproducible, or that rightmodeler does simulation
  or stress testing.

## Untouchables

- Attributed quotes, names and titles, word for word.
- Measured, modeled, projected and illustrative figures, with their hedge words.
- Third-party facts on comparison and integration pages.
- Blog post dates and the founding story's narrative facts.
- CLI machine strings, flags, exit codes and the generated `docs/commands.md`. Help descriptions
  are copy: change them in the CLI source and regenerate `docs/commands.md`. The `re-prove` and
  `reproof` state terms stay as they are.
- No em dashes anywhere.
