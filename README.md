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
> the OpenAI-compatible endpoint you pass with `--base-url`. If your key already lives
> in another variable, name it with `--api-key-env`, for example
> `--api-key-env OPENROUTER_API_KEY`. Only `estimate`, replay and Mode B confirmation
> call your provider, so every stage before replay runs without a key.

## What you need

| You need                                            | Details                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node.js 24 or newer                                 | Run `npx rightmodeler`, or install it with `npm install -g rightmodeler`.                              |
| Your app's Git repository, with at least one commit | It is scanned for model call sites. Run from it or pass `--repo <dir>`.                                |
| Traces of your app's model calls                    | With token usage on each call. See [Traces](#traces).                                                  |
| An OpenAI-compatible endpoint                       | A provider or gateway with a priced model catalog. See [The endpoint](#the-endpoint).                  |
| That endpoint's key in an environment variable      | `RIGHTMODELER_API_KEY` by default, or any variable you name with `--api-key-env`.                      |
| A GitHub token (optional)                           | Only for the pull-request commands. See [From verdict to pull request](#from-verdict-to-pull-request). |
| Docker with a running daemon (optional)             | Only for [Mode B confirmation](#mode-b-confirmation) on its default backend.                           |

## Quick start

Run these from your app's repository. First add `.rightmodeler/` to its `.gitignore`,
because the store the CLI keeps there holds content from your traces. The provider
here is OpenRouter, as an example; any endpoint that meets
[the endpoint contract](#the-endpoint) works the same way.

```bash
# 1. Preview the pipeline stages. Free: needs no traces or key and writes nothing.
npx rightmodeler init --plan

# 2. Run the local stages: scan your code for model call sites, read and scrub the
#    traces, and build the replay cases. Free: no provider call, no key.
npx rightmodeler init --through shortlist --traces ./traces.jsonl
#    Then preview each family's cases (a family is the calls that do one job) and
#    any abstention already known before replay.
npx rightmodeler init --plan

# 3. Export YOUR model provider's key.
export OPENROUTER_API_KEY=...

# 4. Project the worst-case spend. Reads the provider's /models catalog with the key
#    from step 3; calls no model and costs nothing.
npx rightmodeler estimate --traces ./traces.jsonl \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY

# 5. Run the full pipeline. This spends money: it replays your recorded calls on
#    cheaper candidates and pays the judge model to grade every answer. Set
#    --max-cost-usd from the projected cost that step 4 printed; the run stops
#    before any call the cap cannot cover.
npx rightmodeler init --traces ./traces.jsonl \
  --base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY \
  --max-cost-usd 25

# 6. Read the verdicts. Free.
cat .rightmodeler/project/reports/report.md
```

Without `--max-cost-usd` a run is uncapped. Every run resumes from its checkpoints:
when one stops for a missing input or the spend cap, fix what the message names, or
raise the cap, and rerun the same command; do not delete `.rightmodeler/` to restart.

## The key

Every replay and judge call goes straight to the endpoint you pass with `--base-url`,
with no rightmodeler server in between, and the key goes only to that host (on a cloud
Mode B backend, by way of the sandbox platform's egress firewall). The CLI never takes
the key as an argument, prompts for it or loads a `.env` file. For a gateway, use the
key the gateway asks for.

```bash
export RIGHTMODELER_API_KEY=...   # your provider's key, in the default variable
npx rightmodeler init --traces ./traces.jsonl \
  --base-url https://openrouter.ai/api/v1 --max-cost-usd 25

# Or keep the variable you already have and name it.
npx rightmodeler init --traces ./traces.jsonl --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY --max-cost-usd 25
```

## The endpoint

Any model provider or gateway works when it meets this contract:

- **`--base-url`** is its OpenAI-compatible root, usually ending in `/v1`. rightmodeler
  reads `GET <base-url>/models` and sends `POST <base-url>/chat/completions`.
- **The catalog** lists the model your traces recorded (a bare `gpt-4o-mini` also
  matches `openai/gpt-4o-mini`, unless two vendors list it), prices cheaper text models
  to try as candidates, and prices a judge model from a vendor other than both the
  current model's and the candidate's. When your own evaluator grades the replays, the
  judge serves only as its fallback and for Mode B confirmation.
- **A catalog without prices** takes `--catalog-reference <url-or-path>`, a priced
  upstream list fetched without your key, or your own `--pricing-file <path>`.

Two endpoints whose catalogs are priced, as examples:

| Example                                                                          | `--base-url`                      | `--api-key-env`      |
| -------------------------------------------------------------------------------- | --------------------------------- | -------------------- |
| [OpenRouter](https://www.rightmodeler.com/integrations/openrouter)               | `https://openrouter.ai/api/v1`    | `OPENROUTER_API_KEY` |
| [Vercel AI Gateway](https://www.rightmodeler.com/integrations/vercel-ai-gateway) | `https://ai-gateway.vercel.sh/v1` | `AI_GATEWAY_API_KEY` |

When a provider or gateway has a page on the
[integrations hub](https://www.rightmodeler.com/integrations), that page gives its
exact flags, such as its `--catalog-reference` and `--header` values; any other
endpoint follows the contract above. `npx rightmodeler docs getting-started` covers
every pricing source, and `npx rightmodeler docs gateways` what a gateway route needs.

## Traces

rightmodeler reads the traces your stack already records, such as OpenTelemetry GenAI
spans, exports from tracing and evaluation platforms, gateway request logs and
coding-agent sessions. It detects the format from the content, and every replayed call
needs its recorded token usage.

- `--traces <path>` takes a file or a directory. Every trace file in a directory must
  use the same format.
- Without `--traces`, `init` and `estimate` look for trace files in the repository and
  in your local coding-agent sessions for it. In a terminal they let you pick one,
  `--yes` takes the newest, and otherwise they stop and ask for `--traces`. A rerun
  reuses the trace already read.
- `npx rightmodeler docs getting-started` lists the trace sources the installed
  version reads, and each source's page on the
  [integrations hub](https://www.rightmodeler.com/integrations) shows how to get its
  traces onto disk. If your app records none yet, the
  [OpenAI SDK page](https://www.rightmodeler.com/integrations/openai-sdk) shows a
  JSONL log you can write yourself.

## What you get

Everything is written inside the analyzed repository, or under `--store <dir>`:

```text
.rightmodeler/
├── project/reports/report.md   # the report you read
└── .rightmodeler-store/        # versioned checkpoints and evidence; read it through the CLI
```

rightmodeler groups the traced calls into families, the calls that do one job such as
summarizing an article. `report.md` has one row per family and the evidence behind
each decision, which is one of:

| Decision                  | Meaning                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recommend`               | The cheaper model cleared every release gate on the shortlist and held-out cases, and needed no confirmation or passed it. `apply` acts on these. |
| `recommend (gated)`       | The verdict favored the swap, but held-out selection or a release gate failed.                                                                    |
| `recommend (unconfirmed)` | The step feeds a later model-written step, so the swap waits for [Mode B confirmation](#mode-b-confirmation).                                     |
| `reject`                  | An unsafe substitution was seen, or Mode B traced a downstream failure to the swap.                                                               |
| `abstain`                 | The evidence is too thin or unusable. The report names the reason.                                                                                |
| `inconclusive`            | The evidence is complete, but the cheaper model's worst-case quality or availability falls short, so the swap is not proven safe.                 |

For scripts, `--output json` or `jsonl` ends with one result object holding the
verdicts and the report path, `npx rightmodeler report --output json` prints the full
report and `npx rightmodeler status` summarizes the store. Exit code 1 from `init` or
`report` means an actionable recommendation and is a success, 2 means the run needs
input and 3 that it hit the spend cap; `npx rightmodeler docs exit-codes` has the rest.

## What leaves your machine

- **Local stages, `report` and `status`:** nothing. Email addresses and phone numbers
  are redacted before the replay cases are built.
- **`estimate`:** reads your endpoint's model catalog and prices with your key, and any
  `--catalog-reference` list without it. No model is called.
- **Replay and Mode B confirmation:** the scrubbed recorded conversations, and the
  judge's inputs (the task, the recorded output and the candidate's), go to your
  endpoint. During Mode B, your app's model calls go there too.
- **Anything else:** only a service that a command, flag or config file you pass
  names, such as an external evaluator, `corpus import` or `export`, a cloud Mode B
  backend, or GitHub for the pull-request commands.

## From verdict to pull request

```bash
# A GitHub token in any variable. The GitHub CLI's token works.
export GITHUB_TOKEN="$(gh auth token)"

# Run every gate and read GitHub, but write nothing.
npx rightmodeler apply --owner <owner> --github-token-env GITHUB_TOKEN --dry-run

# Open the draft pull request.
npx rightmodeler apply --owner <owner> --github-token-env GITHUB_TOKEN

# One reconcile pass over the open pull request. Run it on a schedule.
npx rightmodeler watch --owner <owner> --pr <number> --github-token-env GITHUB_TOKEN

# Open a draft pull request that restores the files a merged swap changed.
npx rightmodeler rollback --owner <owner> --pr <number> --github-token-env GITHUB_TOKEN
```

- `apply` opens a draft pull request that changes model identifiers only, with the
  evidence for each swap in its body. rightmodeler never merges: a person reviews and
  merges.
- These commands act on `<owner>/<name>` on GitHub, where `<name>` defaults to this
  directory's name; pass `--github-repo <name>` when it differs.
  `npx rightmodeler docs github` covers the tokens, preconditions and refusals.

## Automate it

CI runs the same `init` without a terminal: pass `--traces`, `--base-url`,
`--api-key-env` and `--max-cost-usd`, keep the provider key in the CI system's
secrets, and protect a `.rightmodeler/` kept between runs like the traces themselves.
`npx rightmodeler docs github-actions` prints a ready GitHub Actions workflow pinned to
the installed version, and the integrations hub has a page for each CI recipe.

## Mode B confirmation

A swap whose output feeds a later model-written step can break that step even when its
own answers pass. Such a family stays `recommend (unconfirmed)`, and `apply` skips it,
until Mode B confirms it: it runs your app on recorded cases in an isolated sandbox (a
Docker container by default) with the candidate model in place and judges the final
output. Pass `--modeb-config <file.json>`; your real key never enters the sandbox.
`npx rightmodeler docs modeb` prints the config, the runtime contract and its backends.

## Docs

- `npx rightmodeler --help` lists every command, and `npx rightmodeler <command> --help`
  lists its options, such as a release policy, custom headers and your own evaluator
  in place of the judge; `npx rightmodeler docs evaluators` covers the evaluators.
- `npx rightmodeler docs` lists the guides packaged with the installed version, and
  `npx rightmodeler docs <topic>` prints one, for example
  `npx rightmodeler docs getting-started`. The same guides are in
  [harness/packages/rightmodeler/docs](harness/packages/rightmodeler/docs/).
- The [integrations hub](https://www.rightmodeler.com/integrations) has a page for each
  integration with its setup commands and limits, and
  [rightmodeler.com](https://www.rightmodeler.com) has guides and comparisons.

## Use it from a coding agent

```bash
npx skills add elm-os/rightmodeler --skill rightmodeler
```

Then invoke `rightmodeler` in your coding agent. The skill is a runbook over the same
CLI: it asks for what it does not know (the repository, the trace path, the base URL,
the name of the variable that holds your key and the spend cap), runs the pipeline,
presents each family's verdict and opens the pull request. It never asks for the key's
value and never merges.

## Self-hosted agent

[harness/apps/agent](harness/apps/agent/README.md) is an agent built on the same CLI:
it runs the CLI on schedules and answers collaborators' mentions through a GitHub App.
It is not on npm; build it from a clone and run it on one long-lived host, as its
README describes.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](.github/CONTRIBUTING.md) covers the
setup, the workspace layout, the commands and the pull request conventions. The
canonical skill source lives in `skills/rightmodeler`; do not edit the generated copies
under `.agents/skills/` or `.claude/skills/`.

A new integration needs no edit to this README. Its page data under
`apps/web/src/content/integrations/data` builds its page on the integrations hub, and
the packaged doc for its kind under `harness/packages/rightmodeler/docs/` covers it in
the CLI. CONTRIBUTING.md lists the steps.

To report a security issue, follow [SECURITY.md](.github/SECURITY.md) rather than
opening a public issue. Participation is governed by our
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
