# Getting started

Rightmodeler analyzes recorded model calls, replays them against cheaper candidates, evaluates the outputs, and writes a recommendation report. The intended public package name is `rightmodeler`.

## Requirements

- Node.js 24 or newer.
- A Git repository to analyze.
- Trace input in a supported format.
- An OpenAI-compatible provider base URL and the name of an environment variable containing its API key before replay begins. Its `/v1/models` catalog should publish per-token pricing. OpenRouter and Vercel AI Gateway do. For a LiteLLM endpoint, Rightmodeler can fall back to `GET /model/info`; for bare OpenAI or another unpriced endpoint, pass `--pricing-file`.

Supported trace sources are OTel GenAI, OpenAI JSONL, Langfuse, Braintrust,
LangSmith, OpenInference, Helicone, W&B Weave, Claude Code, and Codex.

## Start with automatic discovery

Run this from the repository you want to analyze:

```sh
npx rightmodeler init
```

Rightmodeler checks conventional local trace files, Claude Code transcripts for
the repository, and Codex sessions whose recorded working directory matches the
repository. In an interactive terminal it lists matches newest-first with an
approximate model-call count. If nothing is found, it explains how to produce or
export a trace and asks for a path. Leaving the answer empty, pressing Ctrl-C or
Ctrl-D, or closing standard input stops cleanly with exit code `2` and a remedy
for rerunning.

## Preview without changing the repository

```sh
npx rightmodeler init --plan --output json --repo /path/to/repository
```

## Run through the free corpus stage

```sh
npx rightmodeler init --through corpus --traces /path/to/traces.json --output json --repo /path/to/repository
```

`--traces` accepts a single file or a directory. A directory is read non-recursively as its `.json` and `.jsonl` files in name order; every file must use the same trace format.

## Run the complete pipeline

```sh
export RIGHTMODELER_API_KEY="provider-key"
npx rightmodeler init --traces /path/to/traces.json --base-url https://provider.example/v1 --output json --repo /path/to/repository
```

`RIGHTMODELER_API_KEY` is the default key variable. Pass
`--api-key-env <name>` to use a different exported variable. The CLI does not ask
for a secret value.

## Estimate replay spend

```sh
npx rightmodeler estimate --traces /path/to/traces.json --base-url https://provider.example/v1 --output json --repo /path/to/repository
```

Estimate projects candidate replay spend from recorded token usage and the current
model catalog before paid model calls begin.

## Release policy

`--policy <path>` is accepted by `init`, `estimate`, `replay`, and `confirm`. The JSON object can set the quality floor, shortlist size, and model allow and deny lists:

```json
{
  "qualityFloor": 0.9,
  "shortlistTop": 5,
  "allowModels": ["acme/small-1"],
  "denyModels": ["acme/large-1"]
}
```

`qualityFloor` must be greater than 0.8 and less than 1, and `shortlistTop` must be a positive integer. Changing the policy changes the stamped gate policy version, so shortlist and replay run again instead of pooling evidence gathered under the old policy.

## Catalogs without pricing

Rightmodeler reads per-token pricing from the model catalog. When every catalog
entry has null pricing and no `--pricing-file` is set, it requests LiteLLM
`GET /model/info` on the same host. Use `--pricing-file` for bare OpenAI
endpoints or when `/model/info` has no usable per-token costs; file entries
override provider pricing.

```sh
npx rightmodeler estimate --base-url https://provider.example/v1 --pricing-file /path/to/pricing.json --repo /path/to/repository
```

The pricing file maps each model id to input and output USD per token and may
include the model's output ceiling:

```json
{
  "acme/model": {
    "input": 0.000001,
    "output": 0.000002,
    "maxOutputTokens": 4096
  }
}
```

Without usable pricing from the catalog, LiteLLM `/model/info`, or a pricing
file, the run refuses with `no_priced_candidates` instead of reporting zero
cost.

The default store is `.rightmodeler/` inside the analyzed repository. Completed stages resume when their inputs and outputs are still current. A complete run writes `.rightmodeler/project/reports/report.md` and `.rightmodeler/project/reports/report.json`.

Read the generated [command reference](commands.md), the [evaluator guide](evaluators.md), [Mode B configuration](modeb.md), and the [exit-code convention](exit-codes.md) before automating a full run.

Run `rightmodeler docs <name>` to print any of these documents from the installed package.
