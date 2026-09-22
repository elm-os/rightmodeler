# Evaluators

The default evaluator is the built-in judge selected from the configured provider catalog. Candidate and reference families are excluded when choosing the judge.

An external evaluator is requested with `--evaluator <provider>` on `init`, `estimate`, `replay`, and `confirm`, where the provider is `braintrust`, `langfuse`, `langsmith`, or `promptfoo`. Every other `--evaluator-*` option is a usage error without `--evaluator`.

## Options shared by every provider

- `--evaluator-scorer <name>` (required, repeatable): the scorer names the provider must return for every case.
- `--evaluator-gate-metric <name>`: the scorer used for release gates. Required when more than one scorer is configured; with a single scorer it defaults to that scorer. It must name a configured scorer.
- `--evaluator-gate-threshold <value>`: pass threshold applied only when the evaluator omits a pass decision for a metric.

## Provider options

One table per provider. A rejected option is a usage error with that provider (exit code 2, `invalid_option`).

### braintrust

`--evaluator-project-id` names the Braintrust project that receives the experiment.

| Option                              | Requirement | Default                      |
| ----------------------------------- | ----------- | ---------------------------- |
| `--evaluator-project-id <id>`       | required    |                              |
| `--evaluator-api-key-env <name>`    | optional    | `BRAINTRUST_API_KEY`         |
| `--evaluator-base-url <url>`        | optional    | `https://api.braintrust.dev` |
| `--evaluator-public-key-env <name>` | rejected    |                              |
| `--evaluator-command <path>`        | rejected    |                              |
| `--evaluator-config <path>`         | rejected    |                              |

### langfuse

Langfuse authenticates with a public key and a secret key read from environment variables. The keys select the project, so there is no project option.

| Option                              | Requirement | Default                      |
| ----------------------------------- | ----------- | ---------------------------- |
| `--evaluator-api-key-env <name>`    | optional    | `LANGFUSE_SECRET_KEY`        |
| `--evaluator-public-key-env <name>` | optional    | `LANGFUSE_PUBLIC_KEY`        |
| `--evaluator-base-url <url>`        | optional    | `https://cloud.langfuse.com` |
| `--evaluator-project-id <id>`       | rejected    |                              |
| `--evaluator-command <path>`        | rejected    |                              |
| `--evaluator-config <path>`         | rejected    |                              |

### langsmith

`--evaluator-project-id` names the LangSmith dataset the experiment references. A scorer may be written `metric=rule-id` to bind a metric name to an evaluator rule; a bare name is used for both.

| Option                              | Requirement | Default                           |
| ----------------------------------- | ----------- | --------------------------------- |
| `--evaluator-project-id <id>`       | required    |                                   |
| `--evaluator-api-key-env <name>`    | optional    | `LANGSMITH_API_KEY`               |
| `--evaluator-base-url <url>`        | optional    | `https://api.smith.langchain.com` |
| `--evaluator-public-key-env <name>` | rejected    |                                   |
| `--evaluator-command <path>`        | rejected    |                                   |
| `--evaluator-config <path>`         | rejected    |                                   |

### promptfoo

promptfoo runs locally. `--evaluator-config` is the assertions file passed to `promptfoo eval --assertions`; `--evaluator-command` is the executable, one path or one command on `PATH` (so not `npx promptfoo`: install it with `npm install -g promptfoo@0.123.1` or pass the path to its binary). No API or project option applies.

| Option                              | Requirement | Default     |
| ----------------------------------- | ----------- | ----------- |
| `--evaluator-config <path>`         | required    |             |
| `--evaluator-command <path>`        | optional    | `promptfoo` |
| `--evaluator-base-url <url>`        | rejected    |             |
| `--evaluator-api-key-env <name>`    | rejected    |             |
| `--evaluator-project-id <id>`       | rejected    |             |
| `--evaluator-public-key-env <name>` | rejected    |             |

rightmodeler is verified against promptfoo 0.123.1. Other releases work as long as they write the same results layout; one that does not stops the run with an error naming its version and the layout rightmodeler reads. A missing executable counts as unreachable (see below).

Each evaluation runs one command in the assertions file's directory, with standard input closed:

`<command> eval --assertions <assertions file> --model-outputs <model outputs file, relative to that directory> --output <temporary results file> --no-write --no-share --no-table --no-progress-bar`

The command gets your environment plus `PROMPTFOO_DISABLE_UPDATE=true`, `PROMPTFOO_DISABLE_VAR_EXPANSION=true`, `PROMPTFOO_FAILED_TEST_EXIT_CODE=100`, `PROMPTFOO_SHORT_CIRCUIT_TEST_FAILURES=false`, `PROMPTFOO_STRIP_GRADING_RESULT=false`, `PROMPTFOO_STRIP_RESPONSE_OUTPUT=false`, and `PROMPTFOO_STRIP_TEST_VARS=false`. So every output is graded exactly once against every assertion, the batch is neither saved to promptfoo's history nor shared, promptfoo skips its startup update check, and your own promptfoo settings cannot change the exit code, turn a failed assertion into an error, or strip the fields rightmodeler reads. Everything else, including your promptfoo login, cache, telemetry setting, and model-graded assertion providers, works as when you run promptfoo yourself. promptfoo receives each candidate output and its execution id only; the input, messages, and reference answer are never sent.

Put `metric: <name>` on every assertion that feeds an `--evaluator-scorer`. A metric's score is promptfoo's named score for it, and it passes only when every assertion carrying it passes. promptfoo always decides pass or fail, so `--evaluator-gate-threshold` never applies. Each assessment's rubric version is `promptfoo@<version>/<metric>/<digest>`, where the digest is the first 16 hex characters of the canonical SHA-256 of the assertions carrying that metric, so editing one of them, or upgrading promptfoo, changes it. A scorer that no assertion carries stops the run with an error naming it.

Before grading, promptfoo renders `{{ }}` templates in an output, reads a `file://` path or loads a `package:` module it names, and strips one trailing newline. rightmodeler compares the output promptfoo graded with the output it sent. A case whose graded output differs beyond that one newline is recorded absent as `external_output_mismatch`, because the grade is not of the candidate's output; a case promptfoo could not grade at all, such as a `file://` path that does not exist, is recorded absent as `external_evaluator_error`, and the other cases in its batch keep their grades. Neither counts as evidence. Replayed outputs are kept in the store, so a rerun after fixing promptfoo does not repeat model calls.

promptfoo also loads a `promptfooconfig.*` and a `.env` file from the directory it runs in, so any next to the assertions file apply: a `defaultTest` there adds its assertions to every case, a `defaultTest` transform makes every case `external_output_mismatch`, and its `env` block can override the settings above. A detached replay's identity (`replay --detach`) covers the assertions file and every `promptfooconfig.*` next to it; a `.env` there is not covered. Keep the assertions file in a directory of its own unless you want those files to apply.

## Reachability, polling, and absences

If the external evaluator is unreachable, the pipeline warns and uses the built-in judge. Hosted scorers run asynchronously, so after launching a run the pipeline polls for up to 5 minutes, starting 250 ms after launch and doubling the wait between polls up to 10 seconds. If a reachable run fails, is still pending when the budget ends, or omits required case results, the pipeline records the missing assessments instead of fabricating scores.

See [Commands](commands.md) for the complete option text and [Getting started](getting-started.md) for provider setup.
