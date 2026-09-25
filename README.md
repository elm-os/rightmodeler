# rightmodeler

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

rightmodeler finds the steps in your AI agent where a cheaper model can do the job,
and proves it from your own traces. It reads the model calls your app already
recorded, replays each step on cheaper models from your provider's live catalog, and
has a judge model from a different vendor grade every answer against the output you
accepted. When a swap clears every gate, `rightmodeler apply` opens a draft pull
request that changes only the model identifier, for you to review and merge.

It runs beside your app, on your machine or in CI, never in your app's request path.
It is open source under the MIT license, with no rightmodeler account, no hosted
service and no telemetry.

> [!IMPORTANT]
> **`RIGHTMODELER_API_KEY` is not a rightmodeler key.** rightmodeler has no accounts
> and issues no keys. `RIGHTMODELER_API_KEY` is only the default _name_ of the
> environment variable the CLI reads **your model provider's key** from: the key for
> whatever OpenAI-compatible endpoint you pass with `--base-url`. If your key already
> lives in another variable, name it with `--api-key-env`, for example
> `--api-key-env OPENROUTER_API_KEY`. A key is needed only when rightmodeler calls your
> provider: for `estimate`, replay and Mode B confirmation (an optional run of your app
> with the candidate model in place). Every stage before replay runs without one.

## What you need

| You need                                                  | Details                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 or newer                                       | Run the CLI with `npx rightmodeler`, or install it with `npm install -g rightmodeler`.                                                                                                                                                                                                                                                                |
| Your app's Git repository                                 | With at least one commit. rightmodeler scans its source for model call sites and ties each traced call to one. Run from the repository or pass `--repo <dir>`.                                                                                                                                                                                        |
| Traces of your app's model calls                          | A file or directory exported from a supported source, with token usage on each call. The format is detected from the content. See [Traces](#traces).                                                                                                                                                                                                  |
| An OpenAI-compatible endpoint with a priced model catalog | A provider or gateway whose `GET /models` lists prices, or any other OpenAI-compatible endpoint plus one pricing flag. It must also offer a judge model from a vendor other than the models being compared, unless your own evaluator grades the replays. Only `estimate`, replay and Mode B confirmation call it. See [The endpoint](#the-endpoint). |
| That endpoint's API key in an environment variable        | `RIGHTMODELER_API_KEY` by default, or any variable you name with `--api-key-env`.                                                                                                                                                                                                                                                                     |
| A GitHub token in an environment variable (optional)      | Only for `apply`, `watch` and `rollback`, named with `--github-token-env`. See [From verdict to pull request](#from-verdict-to-pull-request).                                                                                                                                                                                                         |
| A Mode B backend (optional)                               | Only for [Mode B confirmation](#mode-b-confirmation). The default backend is Docker with a running daemon.                                                                                                                                                                                                                                            |

## Quick start

Run these from your app's repository. First add `.rightmodeler/` to its `.gitignore`:
the CLI keeps its store there, and the store holds content from your traces. Steps 1,
2 and 6 are local and free, step 4 reads the provider's catalog and costs nothing, and
step 5 is the only step that spends money. The provider here is OpenRouter, as an
example; any endpoint that meets [the endpoint contract](#the-endpoint) works the same
way.

```bash
# 1. Preview the pipeline stages. Free: needs no traces or key and writes nothing.
npx rightmodeler init --plan

# 2. Run the local stages: scan your code for model call sites, read and scrub the
#    traces, and build the replay cases. Free: no provider call, no key.
npx rightmodeler init --through shortlist --traces ./traces.jsonl
#    Then preview each family's cases, held-out cases and step ids, and any reason
#    it will abstain, before anything is spent.
npx rightmodeler init --plan

# 3. Export YOUR model provider's key.
export OPENROUTER_API_KEY=...

# 4. Project the worst-case spend. Reads the provider's /models catalog with the key
#    from step 3; calls no model and costs nothing.
npx rightmodeler estimate --traces ./traces.jsonl \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY

# 5. Run the full pipeline. This spends money: it replays each recorded call on the
#    cheaper candidates and pays the judge model to grade every answer. Set
#    --max-cost-usd from the projectedCostUsd that step 4 printed; the run stops
#    before any call the cap cannot cover.
npx rightmodeler init --traces ./traces.jsonl \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY \
  --max-cost-usd 25

# 6. Read the verdicts. Free.
cat .rightmodeler/project/reports/report.md
```

Every run resumes from its checkpoints. Stages already done print `skipped`, so step 5
continues where step 2 stopped. When a run stops for a missing input or the spend cap,
fix what the message names and rerun the same command. Do not delete `.rightmodeler/`
to restart.

In an interactive terminal, a bare `npx rightmodeler init` finds trace files in the
repository and in your local coding-agent sessions, lets you pick one, and asks for the
base URL. It never asks for the key, so export it first as `RIGHTMODELER_API_KEY`, or
pass `--api-key-env <NAME>` to name the variable you exported. Scripts and CI should
pass `--traces` and `--base-url` explicitly.

## How a run works

rightmodeler groups the traced calls into families: the calls that do one job, such as
summarizing an article. Each family gets its own verdict.

`init` runs these stages in order. `--through <stage>` stops after one, and
`npx rightmodeler --help` lists the commands that run the pipeline through a single
stage.

1. **Local stages** (`scan`, `ingest`, `reconcile`, `scrub`, `corpus`, `audit-sample`,
   `shortlist`): find the model call sites in your code, read the traces, tie each
   traced call to a call site, redact email addresses and phone numbers, and build the
   replay cases. No provider call.
2. **`replay`**: picks the cheapest capable candidates from the provider's live
   catalog, replays each recorded call on them, and has a judge model from a different
   vendor (or [your own evaluator](#more-options)) grade each answer against the
   recorded one. This stage spends money.
3. **`aggregate`**: applies the release gates per family and abstains when the
   evidence is too thin.
4. **`confirm`**: runs [Mode B confirmation](#mode-b-confirmation) for swaps that feed
   a later model-written step. With `--modeb-config` set, this stage also spends money:
   your app's model calls and the judge go to the endpoint.
5. **`report`**: writes `report.md`.

After the report, `apply` opens the draft pull request, `watch` keeps it reconciled,
and `rollback` opens a pull request that restores a merged swap's files. See
[From verdict to pull request](#from-verdict-to-pull-request).

## Providers and keys

### The key

- rightmodeler sends every replay and judge call straight to the endpoint you pass
  with `--base-url`. There is no rightmodeler server in between.
- The CLI reads that endpoint's key from an environment variable. `RIGHTMODELER_API_KEY`
  is the default name, and `--api-key-env <NAME>` reads any other variable.
- The CLI sends the key only to the `--base-url` host, as `Authorization: Bearer <key>`.
  On a cloud Mode B backend, the sandbox platform's egress firewall also receives it and
  attaches it to requests for that host (`npx rightmodeler docs modeb`). The CLI never
  takes the key as an argument, never prompts for it, never reads it from standard
  input and never loads a `.env` file. `--header` cannot set `authorization`.
- Use the key your endpoint expects. For a gateway, that is the key the gateway asks
  for, which its page on the
  [integrations hub](https://www.rightmodeler.com/integrations) names. A gateway that
  replaces `Authorization` with its own upstream key accepts any non-empty value.

```bash
# Export the default variable name...
export RIGHTMODELER_API_KEY=...   # your provider's key
npx rightmodeler init --traces ./traces.jsonl --base-url https://openrouter.ai/api/v1

# ...or keep the variable you already have and name it.
npx rightmodeler init --traces ./traces.jsonl \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY
```

When the variable is unset, `init` runs the free stages, then stops at replay with
exit code 2 and names the variable it read:

```text
Provider API key environment variable is not set: RIGHTMODELER_API_KEY Remedy: Set RIGHTMODELER_API_KEY or pass --api-key-env with the name of a populated environment variable.
```

### The endpoint

Any model provider or gateway works when it meets this contract:

- **`--base-url`** is its OpenAI-compatible root, usually ending in `/v1`. rightmodeler
  reads `GET <base-url>/models` and sends `POST <base-url>/chat/completions`.
- **The catalog lists the model your traces recorded**, by its exact id or a unique
  `<vendor>/<id>` match. Otherwise that family abstains.
- **The catalog prices cheaper text models** to try as candidates. The three cheapest
  capable ones are shortlisted by default, and zero-priced models count only with
  `--include-free`.
- **The catalog prices a judge model from another vendor**, different from both the
  current model's vendor and the candidate's. When
  [your own evaluator](#more-options) grades the replays, they need no judge.
- **Headers the endpoint routes by** are passed with `--header 'name: value'`
  (repeatable).

When the catalog lists models without prices, add one of:

- `--catalog-reference <url-or-path>`: a priced upstream model list, such as another
  provider's public `/models`. rightmodeler joins it to the endpoint's entries by
  model id and fetches it without your key or headers.
- `--pricing-file <path>`: your own prices, in USD per token. They override every
  other source, and must cover the current model, the candidates and at least one
  judge:

  ```json
  {
    "acme/model": {
      "input": 0.000001,
      "output": 0.000002,
      "maxOutputTokens": 4096
    }
  }
  ```

When every catalog entry is unpriced and no pricing file is set, rightmodeler also asks
the same host for prices, such as LiteLLM's `GET /model/info`.
`npx rightmodeler docs getting-started` covers every pricing source. Without prices
from any source, the run stops with `no_priced_candidates` (exit code 2).

Two endpoints whose catalogs are priced, as examples:

| Example           | `--base-url`                      | `--api-key-env`      |
| ----------------- | --------------------------------- | -------------------- |
| OpenRouter        | `https://openrouter.ai/api/v1`    | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `AI_GATEWAY_API_KEY` |

When a provider or gateway has a page on the
[integrations hub](https://www.rightmodeler.com/integrations), that page gives the
exact flags (which `--catalog-reference`, which `--header` values) and, where it
records traces, how to export them. Any other endpoint follows the contract above,
adding `--catalog-reference` or `--pricing-file` when its catalog is unpriced.
`npx rightmodeler docs gateways` covers gateways in detail.

Keep the replay route honest: name replay models by their upstream ids, and turn off
fallbacks, model aliases, response caching and request plugins for them. A response
from a model other than the one requested is left out of the evidence as
`attribution_substituted`, and a family with more than 5% of its replays substituted
abstains. Completed replay cells are reused, so after changing the route or `--header`
values, rerun with a fresh `--store <dir>`.

### Spend

- `--max-cost-usd` is optional. Without it a run is uncapped. The cap covers candidate
  replays and judge calls together: each call reserves its worst case before it is
  sent, and a call the cap cannot cover is not sent.
- A run that reaches the cap exits with code 3 and names the cap needed to start the
  next call. That figure covers only the next call, so rerun with a higher cap, such as
  the `projectedCostUsd` from `estimate`, and the run continues where it stopped. For
  example (the figures vary from run to run):

  ```text
  Budget cap is $0.01; raise it to at least $0.0108017 to start this execution Remedy: Rerun with --max-cost-usd 0.0108017.
  ```

- `estimate` builds a worst-case projection from recorded token usage and live catalog
  prices: `projectedCostUsd`, split into `shortlistCostUsd`, `holdoutCostUsd` and
  `judgeCostUsd`. It leaves out external evaluator charges.
- `--max-concurrency <n>` caps concurrent provider requests (default 8).

## Traces

rightmodeler reads the traces your stack already records, such as OpenTelemetry GenAI
spans, exports from tracing and evaluation platforms, gateway request logs and
coding-agent sessions. It detects the format from the content, so there is no format
flag. Every replayed call needs its recorded token usage.

- `npx rightmodeler docs getting-started` lists the trace sources the installed
  version reads.
- Each source's page on the [integrations hub](https://www.rightmodeler.com/integrations)
  shows how to get its traces onto disk and the commands to run on them.

How traces are found:

- `--traces <path>` takes a file or a directory. A directory is read one level deep, in
  name order, and every trace file in it must use the same format.
- Without `--traces`, `init` and `estimate` look for trace files in the repository
  (such as `traces.json`, `traces.jsonl` or a `traces/` directory) and in local
  coding-agent sessions recorded for the repository, such as Claude Code and Codex
  sessions. In a terminal they list what they found, newest first, and let you pick;
  `--yes` takes the newest. Without a terminal or `--yes`, they stop with exit code 2,
  name the files they found and ask for `--traces`.
- After the first ingest, a rerun without `--traces` reuses the trace already read.

If your app has no tracing yet, the simplest format to write yourself is OpenAI-style
JSONL: one JSON object per model call with `case_id` (calls sharing it form one run),
`model`, `messages` (the chat messages sent) and `response` (the chat completion
returned, with its `usage` token counts), plus optional `name` (the family), a
top-level `usage` when the response has none, `timestamp`, `cost_usd` and
`duration_ms`. [harness/fixtures/traces/openai.jsonl](harness/fixtures/traces/openai.jsonl)
shows the format; it is too small for a verdict.

What makes a family replayable:

- Replay resends each recorded conversation as text. Calls whose conversation carries
  tool calls, non-text parts or tool definitions, and call sites that need tools or
  structured output, are left out of the replay sample with a warning.
- Each family is tied to the call sites in your code its traces came from. When the
  traces cannot tell which call site made a call, because several call sites use the
  traced model or one call site serves several families, the family abstains with
  `ambiguous_call_site_binding` before any spend. In AI SDK calls, for example, a
  string-literal `functionId` names the family and ties it to its call site
  (`npx rightmodeler docs getting-started` has the details).
- A family needs enough evidence. About half of the cases are held out to re-check the
  winner, and a family needs enough held-out cases to clear the quality floor (22 at
  the default floor). Its graded replays must also cover enough distinct runs and call
  sites (at least 10 replays from at least 5 runs). Otherwise it abstains, and the
  report names the reason and the count it needs, for example
  `holdout_below_floor_minimum (2 of 22)`. After the local stages,
  `npx rightmodeler init --plan` shows each family's counts and any reason it will
  abstain, before any spend.

## What you get

Everything is written inside the analyzed repository, or under `--store <dir>`:

```text
.rightmodeler/
├── project/reports/report.md   # the report you read
└── .rightmodeler-store/        # versioned checkpoints and evidence; read it through the CLI
```

The CLI does not add `.rightmodeler/` to `.gitignore`. Add it yourself, because the
store holds content from your traces.

On the demo app in [harness/fixtures](harness/fixtures/README.md), run against its stub
provider, `init` ends with this table:

```text
Family | Decision | Evaluator rates | Availability | Worst-case bound | Abstain reason | Confirm | Action | Blocker
--- | --- | --- | --- | --- | --- | --- | --- | ---
summarize | recommend (unconfirmed) | judge: 35/35 (100.0%) | 35/35 (100.0%) | 90.1% |  | blocked |  | Missing --modeb-config for cascade confirmation.
support | abstain |  | 0/0 (0.0%) | 0.0% | ambiguous_call_site_binding (0 of 7) | not_required |  |

Report: <repo>/.rightmodeler/project/reports/report.md
```

`report.md` carries the same verdicts, with each family's excluded share and confidence
band, and adds the gates, the candidate selection, the confirmation status, judge
disagreement, cost and latency receipts (current model against winner, per case) and
the spend. Each row is one family. Its decision is one of:

| Decision                  | Meaning                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recommend`               | The cheaper model cleared every release gate (worst-case quality bound at least 0.85 by default, availability at least 0.7) on shortlist and held-out cases, and needs no confirmation or passed it. `apply` acts on these. |
| `recommend (gated)`       | The verdict favored the swap, but held-out selection or a release gate failed.                                                                                                                                              |
| `recommend (unconfirmed)` | The step feeds a later model-written step, so the swap waits for [Mode B confirmation](#mode-b-confirmation).                                                                                                               |
| `reject`                  | An unsafe substitution was seen, or Mode B traced a downstream failure to the swap.                                                                                                                                         |
| `abstain`                 | The evidence is too thin or unusable. The report names the reason.                                                                                                                                                          |
| `inconclusive`            | The evidence is complete but the worst-case bound falls below the floor, so the swap is not proven safe.                                                                                                                    |

For scripts:

```bash
# Stage events, then one result object with verdicts, familyOutcomes and reportPath.
npx rightmodeler init --traces ./traces.jsonl --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY --max-cost-usd 25 --output jsonl

# The full report as one JSON line.
npx rightmodeler report --output json | jq '.families[] | {familyId, decisionDisplay}'

# Spend by actor, fact counts, corpus version and the last run.
npx rightmodeler status
```

### Exit codes

| Code | Pipeline commands (`init`, the stage commands, `report`)                                                  |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Finished with no actionable recommendation. `--plan` and `--through` runs also exit 0.                    |
| 1    | A complete `init` or `report` found an actionable recommendation. This is a success.                      |
| 2    | Needs input: traces, provider settings, a Git repository with a commit, or a valid option. Fix and rerun. |
| 3    | Reached `--max-cost-usd`. Raise the cap and rerun.                                                        |
| 10+  | Runtime or command-line failure.                                                                          |

Pipeline errors go to standard error as `<message> Remedy: <remedy>`, or as one JSON
object `{"code","message","remedy"}` with `--output json` or `jsonl`. `apply`, `watch`,
`rollback` and `drift` have their own codes; `npx rightmodeler docs exit-codes` lists
every command's codes and every error code.

## What leaves your machine

- **Local stages, `report` and `status`:** nothing. Before the corpus is built, email
  addresses and phone numbers in messages, system prompts and recorded outputs are
  replaced with `[REDACTED:email]` and `[REDACTED:phone]`.
- **`estimate`:** `GET <base-url>/models` with your key and `--header` values, plus a
  price request to the same host (such as LiteLLM's `GET /model/info`) when the
  catalog has no prices and no pricing file is set. A `--catalog-reference` URL is
  fetched without your key or headers. No model is called.
- **Replay:** the scrubbed recorded conversations go to
  `POST <base-url>/chat/completions`, and the judge calls to the same endpoint carry
  the task, the recorded output and the candidate's output. During Mode B
  confirmation, your app's model calls go to the same endpoint.
- **Anything else, only when you ask for it:** rightmodeler contacts a service other
  than your endpoint only when a command, flag or config file you pass names it, for
  example an external evaluator, `corpus import` and `export`, a cloud Mode B backend,
  or the pull-request commands (`apply`, `watch`, `rollback`).

## From verdict to pull request

```bash
# A GitHub token in any variable. The GitHub CLI's token works.
export GITHUB_TOKEN="$(gh auth token)"

# Run every gate and read GitHub, but write nothing. Prints the branch, title, body,
# files and reviewers it would use.
npx rightmodeler apply --owner <owner> --github-token-env GITHUB_TOKEN --dry-run

# Open the draft pull request.
npx rightmodeler apply --owner <owner> --github-token-env GITHUB_TOKEN

# One reconcile pass: answer reviews, react to failing checks, record a merge or close.
# Run it on a schedule.
npx rightmodeler watch --owner <owner> --pr <number> --github-token-env GITHUB_TOKEN

# Open a draft pull request that restores the files a merged swap changed.
npx rightmodeler rollback --owner <owner> --pr <number> --github-token-env GITHUB_TOKEN
```

- `--owner` and `--github-token-env` are required, and there is no default token
  variable. `--github-repo` defaults to the repository directory's name, and
  `--github-base-url` to `https://api.github.com`. For GitHub Enterprise Server, pass
  its `/api/v3` URL; `npx rightmodeler docs github` names the versions it supports.
- `apply` needs a completed `init` with at least one `recommend`, local `HEAD` on a
  branch at the evidence revision with that branch pushed to GitHub at the same
  revision, and no uncommitted change in the files the swap touches. Without a
  completed `init`, it exits 2 and names the stage to run. When a gate fails, it exits
  1 with `status: "refused"` and a reason code.
- The pull request is a draft that changes model identifiers only. Its body carries a
  `## Rightmodeler evidence` table with each family's decision, worst-case bound,
  models, cost per case and latency, and case IDs as SHA-256 digests, never prompts.
  Reviewers come from CODEOWNERS, else the file's recent `git blame` authors.
- rightmodeler never merges. A person reviews and merges.
- Tokens: a GitHub App installation token (recommended) or a classic token with the
  `repo` scope covers everything. A fine-grained token works for `apply`; `watch` then
  reads commit statuses instead of check runs. `npx rightmodeler docs github` lists
  the permissions and every refusal code.

## Automate it

CI runs the same `init` without a terminal: pass `--traces`, `--base-url`,
`--api-key-env` and `--max-cost-usd` explicitly, keep the provider key in the CI
system's secrets, and read the [exit codes](#exit-codes). Wherever the job keeps
`.rightmodeler/` between runs, protect it like the traces themselves, because the store
holds their content.

```bash
# For example: print a ready GitHub Actions workflow, pinned to the installed version,
# with its setup steps and where it keeps the store.
npx rightmodeler docs github-actions
```

The [integrations hub](https://www.rightmodeler.com/integrations) has a page for each CI
recipe and source-control integration.

## Mode B confirmation

A swap whose output feeds a later model-written step can break that later step even
when its own answers pass. For those families, the report shows
`recommend (unconfirmed)` until Mode B confirms the swap: the family does not count
toward exit code 1, and `apply` proposes only families whose confirmation passed or was
not required (with none, it refuses with `no_confirmed_recommendation`). Mode B runs
your application on recorded cases in an isolated sandbox (a Docker container on the
default backend), with the candidate model in place, and judges the final output.

- Pass `--modeb-config <file.json>`: the image, the command that runs one case, and a
  map from step ids (`npx rightmodeler init --plan` lists each family's) to the
  `x-rm-step` header your app sends with each model request.
- The default backend is `docker`: the `docker` CLI must reach a running daemon.
  `npx rightmodeler docs modeb` covers the other backends and their credentials.
- Your app reaches the model through a proxy at `OPENAI_BASE_URL` with a placeholder
  key. Your real key never enters the sandbox.

`npx rightmodeler docs modeb` prints the full config and runtime contract.

## More options

- `--evaluator <name>` with at least one `--evaluator-scorer <name>` grades with your
  own scorers instead of the built-in judge. `npx rightmodeler init --help` lists the
  evaluators the installed version supports, and `npx rightmodeler docs evaluators`
  gives each one's options and key variables.
- `--policy <file.json>` sets the quality floor (above 0.8 and below 1, default 0.85),
  the shortlist size (default 3) and model allow and deny lists.
- `--code-graph <graph.json>` adds static code context from a Graphify graph to the
  report and the pull request body. It is never used as evidence.
- `replay --detach` returns a run id to check with `status --run <id>`.
- `drift --traces <path>` checks new traffic against the active replay corpus.
- `corpus import --from <provider>:<dataset>` builds the corpus from an evaluation
  platform's dataset (for example `braintrust:<dataset>`), and `export --to <provider>`
  sends trials and verdicts back. Each platform's page on the integrations hub shows
  its commands, and `npx rightmodeler export --help` lists the `--to` choices.

## Docs

- `npx rightmodeler --help` lists every command, and `npx rightmodeler <command> --help`
  lists its options.
- `npx rightmodeler docs` lists the guides packaged with the installed version, and
  `npx rightmodeler docs <topic>` prints one, for example
  `npx rightmodeler docs getting-started`. The same guides are in
  [harness/packages/rightmodeler/docs](harness/packages/rightmodeler/docs/).
- The [integrations hub](https://www.rightmodeler.com/integrations) has a page for each
  integration, grouped by what it does, with its setup commands and limits.
- Guides and comparisons are at [rightmodeler.com](https://www.rightmodeler.com).

## Use it from a coding agent

```bash
npx skills add elm-os/rightmodeler --skill rightmodeler
```

Then invoke `rightmodeler` in your coding agent. The skill is a runbook over the same
CLI: it asks for whatever it does not know yet (the repository, the trace path, the base
URL, the name of the variable that holds your key and the spend cap), runs the
pipeline, reads the exit codes, presents each family's verdict, and opens the pull
request with `apply --dry-run` then `apply`. It never asks for the key's value and
never merges.

## Self-hosted agent

[harness/apps/agent](harness/apps/agent/README.md) is an agent built on the same CLI.
It runs the CLI on schedules and answers mentions from repository collaborators through
a GitHub App. It is not published to npm: build it from a clone and run it on one
long-lived host. Its README covers the requirements and the configuration.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](.github/CONTRIBUTING.md) covers the
setup, the workspace layout, the commands, and the pull request conventions.

The canonical skill source lives in `skills/rightmodeler`. Do not edit generated
copies under `.agents/skills/` or `.claude/skills/`.

A new integration needs no edit to this README, which links to the hub and the
packaged docs: document it in its page data under
`apps/web/src/content/integrations/data` (registered in
`apps/web/src/content/integrations/index.ts`, with its logo under
`apps/web/public/integrations/logos`), which builds its page on the integrations hub,
and in the packaged doc for its kind under `harness/packages/rightmodeler/docs/`, for
example the supported trace sources in `getting-started.md` or a gateway in
`gateways.md`.

To report a security issue, follow [SECURITY.md](.github/SECURITY.md) rather than
opening a public issue. Participation is governed by our
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
