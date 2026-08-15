# Getting started

Rightmodeler analyzes recorded model calls, replays them against cheaper candidates, evaluates the outputs, and writes a recommendation report. The intended public package name is `rightmodeler`.

## Requirements

- Node.js 24 or newer.
- A Git repository to analyze.
- Trace input in a supported format.
- An OpenAI-compatible provider base URL and the name of an environment variable containing its API key before replay begins.

## Preview without changing the repository

```sh
npx rightmodeler init --plan --output json --repo /path/to/repository
```

## Run through the free corpus stage

```sh
npx rightmodeler init --through corpus --traces /path/to/traces.json --output json --repo /path/to/repository
```

## Run the complete pipeline

```sh
export RIGHTMODELER_API_KEY="provider-key"
npx rightmodeler init --traces /path/to/traces.json --base-url https://provider.example/v1 --output json --repo /path/to/repository
```

The default store is `.rightmodeler/` inside the analyzed repository. Completed stages resume when their inputs and outputs are still current. A complete run writes `.rightmodeler/project/reports/report.md` and `.rightmodeler/project/reports/report.json`.

Read the generated [command reference](commands.md), the [evaluator guide](evaluators.md), [Mode B configuration](modeb.md), and the [exit-code convention](exit-codes.md) before automating a full run.
