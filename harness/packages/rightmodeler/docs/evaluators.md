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

promptfoo runs locally. `--evaluator-config` is the assertions file passed to `promptfoo eval --assertions`; `--evaluator-command` is the executable. No API or project option applies.

| Option                              | Requirement | Default     |
| ----------------------------------- | ----------- | ----------- |
| `--evaluator-config <path>`         | required    |             |
| `--evaluator-command <path>`        | optional    | `promptfoo` |
| `--evaluator-base-url <url>`        | rejected    |             |
| `--evaluator-api-key-env <name>`    | rejected    |             |
| `--evaluator-project-id <id>`       | rejected    |             |
| `--evaluator-public-key-env <name>` | rejected    |             |

## Reachability, polling, and absences

If the external evaluator is unreachable, the pipeline warns and uses the built-in judge. Hosted scorers run asynchronously, so after launching a run the pipeline polls for up to 5 minutes, starting 250 ms after launch and doubling the wait between polls up to 10 seconds. If a reachable run fails, is still pending when the budget ends, or omits required case results, the pipeline records the missing assessments instead of fabricating scores.

See [Commands](commands.md) for the complete option text and [Getting started](getting-started.md) for provider setup.
