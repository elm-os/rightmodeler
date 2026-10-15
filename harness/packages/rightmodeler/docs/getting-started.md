# Getting started

Rightmodeler analyzes recorded model calls, replays them against cheaper candidates, evaluates the outputs, and writes a recommendation report. Published on npm as `rightmodeler`.

## Requirements

- Node.js 24 or newer.
- A Git repository to analyze.
- Trace input in a supported format.
- An OpenAI-compatible provider base URL and the name of an environment variable containing its API key before replay begins. Its `/v1/models` catalog should publish per-token pricing. OpenRouter and Vercel AI Gateway do. For a LiteLLM endpoint, Rightmodeler can fall back to `GET /model/info`; for a gateway that lists bare model ids or a direct OpenAI or Anthropic key, pass `--catalog-reference`; for another unpriced endpoint, pass `--pricing-file`.

Instead of an API key, candidates or the judge can run through the `claude`
CLI you are signed in to on this machine, under your Claude plan:
`--route claude-login` with a `--judge-route` from another vendor. Run
`rightmodeler docs model-routes` for what a plan route measures, what it costs
your plan, and its safeguards.

Supported trace sources are OTel GenAI, AI SDK telemetry, OpenAI JSONL,
Langfuse, Braintrust, LangSmith, OpenInference, Helicone, Bifrost, W&B Weave,
Claude Code, and Codex.

## Start with automatic discovery

Run this from the repository you want to analyze:

```sh
npx rightmodeler init
```

Before it looks for traces, an interactive `init` or `estimate` that will reach
replay asks how to call models: through the `claude` or `codex` CLI signed in on
this machine, or through an API key for OpenRouter, Vercel AI Gateway, OpenAI,
Anthropic or another OpenAI-compatible endpoint. It prints the equivalent flags
and saves the answer as the next default, which `--yes` applies without asking.
`npx rightmodeler docs model-routes` describes the choice.

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

## OpenInference spans

When an OpenInference span carries the request body in `input.value` (Envoy AI Gateway, and the OpenAI instrumentation), rightmodeler reads the model your application asked for and the conversation exactly as sent from it, and the output from `output.value`. Spans that share a `session.id` form one run ordered by start time. A `rightmodeler.family` attribute names the family; otherwise the span name does. Failed calls, calls tagged `rightmodeler.replay`, and calls whose content was hidden are left out with a `trace_steps_excluded` warning.

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

## Which models are tried

For each call site, the shortlist takes the catalog models that have a per-token price and cost strictly less than the call site's current model at a blended price (input weighted three to one over output), support what the call site needs (tool calls, structured output, its recorded context and output length), pass the policy's `allowModels` and `denyModels` and, on a plan route, the route's model list, and are not zero-priced unless you pass `--include-free`. By default it keeps only models released on or after the UTC day 90 days before the shortlist is planned: a shortlist planned on 2026-10-15 tries models released on or after 2026-07-17. It ranks the cheapest first and puts a model behind any model that costs no more and is no older, with exact ties in model id order, then keeps the policy's `shortlistTop`, 3 by default, at each call site.

The window is fixed when the shortlist for a set of inputs is first planned, and it is stored with that plan, so later commands on the same inputs use the same window: `estimate` and then `replay`, a rerun after a budget cap or a plan's usage limit, and a detached replay, whose worker counts from the day the replay was claimed if it has to plan the shortlist. Turning an option such as `--include-free` on and then off again returns to the first plan and its window. When the inputs change, for example with new traces or another `--policy`, the shortlist is planned again and its window counts back from that day. While a watch re-proof is pending and no release-date option is passed, a new shortlist keeps the window of the one it replaces, so the open pull request's model is tested again under the window it was chosen in.

- `--released-since <date-or-days>` starts the window on a UTC date (`2026-01-01`) or a number of days before the day the shortlist is planned (`365d`), counted like the default when that plan is first built.
- `--released-until <date>` ends the window on a UTC date, that day included; alone, it ends a 90-day window.
- `--candidate <id>` replays the models you name instead of the automatic shortlist; repeat it to name several. Each name is matched to the catalog as a recorded model is: the exact id, then an id that ends in `/<name>`, then the same model name written another way (`claude-haiku-4-5-20251001` for `anthropic/claude-haiku-4.5`), within the vendor when the name gives one. A name that matches no model, or more than one, stops the run with `unknown_candidate` before any model call. A named model is tried whatever its release date and beyond `shortlistTop`, in each family where it passes the other checks above at every call site. `--candidate` cannot be combined with `--released-since` or `--released-until`.

A model the catalog gives no release date is not tried while a window applies, and the policy's `allowModels` never widens the window; name the model with `--candidate` instead. `--approved-run` replays the approved model only and takes none of these options. Pass the same options on every later command for the same store, as with `--include-free` and `--policy`: a command without them goes back to the default shortlist.

Release dates come from the catalog's `released`, `created` or `created_at` field, and the dates in a `--catalog-reference` replace the gateway's (see [Catalogs without pricing or capabilities](#catalogs-without-pricing-or-capabilities)); on a plan route they come from the price list. When the catalog's priced models carry fewer than two distinct release dates, as when a gateway gives every model one placeholder date, the default window is not applied: the run warns `release_window_skipped` and ranks the candidates by price, and an explicit `--released-since` or `--released-until` stops with `release_dates_unavailable`.

When the window leaves no cheaper model at any call site of a family, a `shortlist_no_recent_candidates` warning names the family and how many cheaper models it left out, and when that leaves no call site with a candidate, the run stops before any model call with `no_recent_candidates`. A named model that a family cannot use gets a `shortlist_candidate_left_out` warning with the reason, and when no named model can be tried at any call site, the run stops with `named_candidates_ineligible`, giving each model's reason.

`estimate` prints the window it applied as `releaseWindow` (`null` when none applies) and, per call site, `droppedByReleaseWindow`, the number of cheaper models the window left out. The report and the draft pull request list the window as `released since` and, when it has an end, `released until`, and the models named with `--candidate` as `named candidates`; when a window applied, the report adds `droppedByReleaseWindow` per call site. A store whose shortlist was planned by rightmodeler 0.4.0 or earlier keeps that shortlist, with no window and candidates ranked by price, until its inputs change; to apply the 90-day window sooner, pass `--released-since 90d` on each command.

## Catalogs without pricing or capabilities

Rightmodeler reads per-token pricing from the model catalog. When every catalog
entry has null pricing and no `--pricing-file` is set, it requests LiteLLM
`GET /model/info` on the same host. Use `--pricing-file` when `/model/info` has
no usable per-token costs; file entries override provider pricing.

Some gateways answer `/v1/models` with bare model ids: Envoy AI Gateway lists
the models a route declares, and Bifrost lists custom providers with ids and
context only. Pass `--catalog-reference <url|path>` to name the upstream's own
model list, for example `https://ai-gateway.vercel.sh/v1/models` or
`https://openrouter.ai/api/v1/models`. Rightmodeler reads it without your key or
headers and joins it to the gateway's entries by id, or by the reference id a
gateway id ends with (`openai/gpt-4o-mini` for `vercel/openai/gpt-4o-mini`). A
gateway entry takes from its match only what it does not declare itself (price,
context window, output ceiling, tool and structured-output support); a match
that is not a language model removes the entry; `--pricing-file` values win over
both. Entries still unpriced after the join are named in a
`catalog_reference_unmatched` warning, and a reference that cannot be read stops
the run with `invalid_catalog_reference`.

The release date is the one field where the reference wins over the gateway:
when the matched reference entry has a release date, it replaces the date the
gateway declares, and the gateway's date is kept only when the reference gives
none. Rightmodeler ranks judges partly by how recent a model is, and by default
tries only candidates released in the last 90 days (see
[Which models are tried](#which-models-are-tried)). A gateway can give every
model the same placeholder date (Bifrost does for Vercel AI Gateway's models),
which would leave context and price to rank the judges and favor the most
expensive, and would leave the default release window unapplied.

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

Without usable pricing from the catalog, a catalog reference, LiteLLM
`/model/info`, or a pricing file, the run refuses with `no_priced_candidates`
instead of reporting zero cost. The judge must be priced too, so price at least
one model from a family other than the current model's and the candidate's.

### Direct OpenAI and Anthropic keys

Point `--base-url` at `https://api.openai.com/v1` or
`https://api.anthropic.com/v1` and name the variable that holds the key with
`--api-key-env`. Neither vendor's model list publishes prices, so also pass
`--catalog-reference https://ai-gateway.vercel.sh/v1/models`. Rightmodeler takes
the vendor from these two hosts: their bare ids are that vendor's models and
join the reference as `openai/<id>` or `anthropic/<id>`. Dated and dotted forms
of a name match within one vendor, in the reference and in your traces, so
`claude-haiku-4-5-20251001` matches `anthropic/claude-haiku-4.5`. For Anthropic,
rightmodeler sends `anthropic-version: 2023-06-01` (a
`--header 'anthropic-version: ...'` value wins), reads every page of the model
list, and never asks for structured output, which Anthropic's OpenAI-compatible
endpoint ignores. For OpenAI, rightmodeler caps a reply's length with
`max_completion_tokens`, which OpenAI's chat reference names in place of the
deprecated `max_tokens`; every other host still gets `max_tokens`.

The built-in judge must come from a vendor other than both the candidate's and
the recorded model's, and rightmodeler checks this before any paid call, also
when an unreachable `--evaluator` falls back to the built-in judge. One vendor's
key lists only that vendor's models, so a run on it alone stops with
`no_neutral_judge` unless the judge runs through the other vendor's CLI you are
signed in to (`--judge-route`, see `rightmodeler docs model-routes`) or your own
evaluator grades the replays. Bare ids from any other host name no vendor, and
a run on them stops with `judge_family_unknown`; use a gateway whose ids carry
their vendor (`vendor/model`), or `--evaluator`.

## Which model answered

Rightmodeler checks every replay and judge response, and in Mode B every response to a step whose model it sets, before it counts. It records the model the response names, and it leaves a response out of the evidence when that model is not the one it asked for, when a gateway reports that it answered from its cache (Portkey's `x-portkey-cache-status: HIT`, Bifrost's `cache_debug.cache_hit`), or when a gateway reports that it changed the request (a Portkey hook with `transformed: true`, Bifrost's compat plugin dropping parameters). Such a response is recorded with `attribution: "substituted"`, is never graded, and counts as `attribution_substituted`; more than 5% of a family's replays substituted abstains the family. A `replay_responses_substituted` warning counts them.

A response names the requested model when it echoes it, when it drops a gateway provider prefix (`openai/gpt-4o-mini` for `vercel/openai/gpt-4o-mini`), or when it adds a dated snapshot (`gpt-4o-mini-2024-07-18` for `gpt-4o-mini`). An alias whose answering model has another name counts as substituted, so name replay models by their upstream ids and turn off fallbacks, model aliases, response caching and request plugins for the replay route. Completed replay cells are reused, so after fixing the route rerun with a fresh store (`--store <directory>`). For streamed Mode B calls only the model a stream names and the response headers are checked.

A judge whose response names another model is retired at that first response: rightmodeler starts no new call to it, cancels its calls still waiting for budget, and re-judges the affected replays with the next-ranked judge once the calls already under way return; the `judge_unusable` warning names the model that answered. Some catalogs also list a faster service tier of a model under its own id, which the gateway answers as the base model: on Vercel AI Gateway, `<id>-fast` is `<id>` at its fast tier. Rightmodeler never ranks such an id as a judge or shortlists it as a candidate while `<id>` is in the catalog too, and it never shortlists a batch tier, `<id>-batch` or `<id>:batch`, while `<id>` is listed; an id that ends in `-fast` with no base model listed, such as `morph/morph-v3-fast`, is treated like any other model.

## Gateways that route by header

Some gateways choose the upstream, the cache policy, or a trace tag from request headers. Pass each one with `--header 'name: value'`; repeat the option for more. Rightmodeler sends them with every request it makes to the provider base URL: the model catalog, candidate replays, judge calls, and the calls Mode B makes from your application, where a configured header replaces one your application sends. `authorization` comes only from `--api-key-env`, and `content-type`, `content-length` and `host` are set by rightmodeler, so none of them can be passed as a header. Completed replay cells are reused when the headers change, so after changing the route rerun with a fresh store (`--store <directory>`). A detached replay run is keyed to the header values by their SHA-256 digests; the values themselves are passed to the detached worker on its command line and are not written to the store. Do not put secrets in headers.

The default store is `.rightmodeler/` inside the analyzed repository. Completed stages resume when their inputs and outputs are still current. A complete run writes `.rightmodeler/project/reports/report.md`. The JSON report is kept inside the versioned store and is never written as a plain file, so read the final `result` event from `--output json` or `--output jsonl` for the machine-readable outcome.

Read the generated [command reference](commands.md), the [evaluator guide](evaluators.md), [Mode B configuration](modeb.md), the [gateway guide](gateways.md), and the [exit-code convention](exit-codes.md) before automating a full run.

To open the draft pull request and keep it reconciled, read the [GitHub guide](github.md).

Run `rightmodeler docs <name>` to print any of these documents from the installed package.
