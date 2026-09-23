# Getting started

Rightmodeler analyzes recorded model calls, replays them against cheaper candidates, evaluates the outputs, and writes a recommendation report. Published on npm as `rightmodeler`.

## Requirements

- Node.js 24 or newer.
- A Git repository to analyze.
- Trace input in a supported format.
- An OpenAI-compatible provider base URL and the name of an environment variable containing its API key before replay begins. Its `/v1/models` catalog should publish per-token pricing. OpenRouter and Vercel AI Gateway do. For a LiteLLM endpoint, Rightmodeler can fall back to `GET /model/info`; for bare OpenAI or another unpriced endpoint, pass `--pricing-file`.

Supported trace sources are OTel GenAI, AI SDK telemetry, OpenAI JSONL,
Langfuse, Braintrust, LangSmith, OpenInference, Helicone, W&B Weave, Claude
Code, and Codex.

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

Each family is replayed only against the call sites its own traces came from. Traced cases that cannot be tied to one such call site, because several call sites use the traced model or none matches it, are left out of the replay sample with a `family_cases_left_out` warning. A family with no case left abstains before any spend with `ambiguous_call_site_binding` or `unmatched_call_site_binding`. The AI SDK telemetry `functionId` (see below) is the way to tie an AI SDK call site to its family.

## AI SDK telemetry

The AI SDK emits telemetry in two dialects, and Rightmodeler reads both:

- The `ai.*` dialect comes from AI SDK 5 and 6 with `experimental_telemetry: { isEnabled: true }` on each call, and from AI SDK 7 with `registerTelemetry(new LegacyOpenTelemetry())`. The AI SDK reader reads it.
- The GenAI semantic conventions dialect comes from AI SDK 7 with `registerTelemetry(new OpenTelemetry())`. The OTel GenAI reader reads it and treats the agent, step and tool spans as structure, so each model call counts once.

`registerTelemetry` comes from `ai`; `LegacyOpenTelemetry` and `OpenTelemetry` come from `@ai-sdk/otel`. Register only one of them: an export that holds both dialects is ambiguous. Keep `recordInputs` and `recordOutputs` on, which is the default, because a model call without its prompt or output cannot become a corpus case. Set a string-literal `functionId` on every call (`telemetry: { functionId: "summarize" }` in AI SDK 7, `experimental_telemetry: { isEnabled: true, functionId: "summarize" }` before it); it becomes the call's family.

The scanner records that `functionId` on the call site, and a family binds to exactly the call sites whose `functionId` equals its name: its evidence and any swap stay on those call sites, and no other family borrows them. Two call sites that do the same job may share one `functionId`. A family bound to a single call site can still be recommended. The `functionId` must be a string literal in the call; a variable or a template literal is not read, and the call site then binds by model id only. Replay cannot run a call site that needs tools or structured output: its cases are left out of the family's replay sample with a `family_cases_left_out` warning, and a family whose traced cases all come from such call sites abstains with `bound_call_sites_not_replayable` before any spend.

Export the spans through the OpenTelemetry NodeSDK or `@vercel/otel` to an OTLP collector, and pass the collector's file exporter output with `--traces`. A model call that ended without a finish reason, because it was aborted or errored, is left out of the corpus with a `trace_steps_excluded` warning, and the rest of the input is read. Token usage from AI SDK 4 exports (`ai.usage.promptTokens`) is not read, so those calls carry no usage.

## Run the complete pipeline

```sh
export RIGHTMODELER_API_KEY="provider-key"
npx rightmodeler init --traces /path/to/traces.json --base-url https://provider.example/v1 --output json --repo /path/to/repository
```

`RIGHTMODELER_API_KEY` is the default key variable. Pass
`--api-key-env <name>` to use a different exported variable. The CLI does not ask
for a secret value.

Replay resends each recorded conversation as text. A recorded case whose conversation contains tool calls, non-text parts, or tool definitions is left out of the replay sample with a `recorded_messages_not_replayable` warning; the family's other cases replay, and a family left with too few cases abstains under the usual sample-size reasons.

## Estimate replay spend

```sh
npx rightmodeler estimate --traces /path/to/traces.json --base-url https://provider.example/v1 --output json --repo /path/to/repository
```

Estimate projects candidate replay spend from recorded token usage and the current
model catalog before paid model calls begin.
`--max-cost-usd` caps candidate replays and judge calls together: each call reserves
its worst case before it is sent, and a call the cap cannot cover is not sent.

## Static code context (Graphify)

rightmodeler can read a code graph built by the open-source Graphify CLI (PyPI package `graphifyy`, Apache-2.0, tested with 0.9.65). Graphify builds it locally from your source, with no account and no model call.

```sh
uv tool install graphifyy
graphify update .
npx rightmodeler report --code-graph graphify-out/graph.json --repo .
```

`init --code-graph <path>` renders the same section at the end of a run. For each call site the scanner found, the section lists the enclosing symbol, its callers, the tests that reach it, and the owners of those files, which are listed only. It also lists files that import an AI SDK where the scanner found no call site.

Graph edges are never replay trials, runtime proof, or quality evidence, and the flag never changes a stage before the report, a verdict, a gate, or confirmation. Each finding is labelled EXTRACTED, or INFERRED or AMBIGUOUS to verify, by its weakest hop. A graph built at another commit is shown file-level with a stale note. An unusable graph produces one warning, the section says why it is not shown, and the rest of the report is unchanged. The scan ignores `graphify-out/`, so building a graph never makes finished stages stale. Only `graphify update` and `graphify extract --code-only` are needed; other Graphify commands can call a language model.

`apply --code-graph <path>` appends the same section to the draft pull request body, limited to the call sites the pull request swaps and to five findings of each kind per call site. Owners there are listed only and are never requested as reviewers; reviewers still come from CODEOWNERS and blame. The graph never changes the swap, its digest, or its reviewers. `apply --dry-run` prints the exact body it would post, with or without `--code-graph`.

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
cost. The judge must be priced too, so price at least one model from a family
other than the current model's and the candidate's.

## Which model answered

Rightmodeler checks every replay and judge response, and in Mode B every response to a step whose model it sets, before it counts. It records the model the response names, and it leaves a response out of the evidence when that model is not the one it asked for, when a gateway reports that it answered from its cache (Portkey's `x-portkey-cache-status: HIT`, Bifrost's `cache_debug.cache_hit`), or when a gateway reports that it changed the request (a Portkey hook with `transformed: true`, Bifrost's compat plugin dropping parameters). Such a response is recorded with `attribution: "substituted"`, is never graded, and counts as `attribution_substituted`; more than 5% of a family's replays substituted abstains the family. A `replay_responses_substituted` warning counts them.

A response names the requested model when it echoes it, when it drops a gateway provider prefix (`openai/gpt-4o-mini` for `vercel/openai/gpt-4o-mini`), or when it adds a dated snapshot (`gpt-4o-mini-2024-07-18` for `gpt-4o-mini`). An alias whose answering model has another name counts as substituted, so name replay models by their upstream ids and turn off fallbacks, model aliases, response caching and request plugins for the replay route. Completed replay cells are reused, so after fixing the route rerun with a fresh store (`--store <directory>`). For streamed Mode B calls only the model a stream names and the response headers are checked.

## Gateways that route by header

Some gateways choose the upstream, the cache policy, or a trace tag from request headers. Pass each one with `--header 'name: value'`; repeat the option for more. Rightmodeler sends them with every request it makes to the provider base URL: the model catalog, candidate replays, judge calls, and the calls Mode B makes from your application. `authorization` comes only from `--api-key-env`, and `content-type`, `content-length` and `host` are set by rightmodeler, so none of them can be passed as a header. A detached replay run is keyed to the header values by their SHA-256 digests; the values themselves are passed to the detached worker on its command line and are not written to the store. Do not put secrets in headers.

The default store is `.rightmodeler/` inside the analyzed repository. Completed stages resume when their inputs and outputs are still current. A complete run writes `.rightmodeler/project/reports/report.md`. The JSON report is kept inside the versioned store and is never written as a plain file, so read the final `result` event from `--output json` or `--output jsonl` for the machine-readable outcome.

Read the generated [command reference](commands.md), the [evaluator guide](evaluators.md), [Mode B configuration](modeb.md), and the [exit-code convention](exit-codes.md) before automating a full run.

To open the draft pull request and keep it reconciled, read the [GitHub guide](github.md).

Run `rightmodeler docs <name>` to print any of these documents from the installed package.
