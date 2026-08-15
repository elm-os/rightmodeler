# Evaluators

The default evaluator is the built-in judge selected from the configured provider catalog. Candidate and reference families are excluded when choosing the judge.

An external evaluator can be requested with `--evaluator braintrust`. Configure it with:

- `--evaluator-project-id <id>` (required)
- one or more `--evaluator-scorer <name>` options (required)
- `--evaluator-api-key-env <name>` (defaults to `BRAINTRUST_API_KEY`)
- `--evaluator-base-url <url>` (defaults to the provider API)
- `--evaluator-gate-metric <name>` when more than one scorer is configured
- `--evaluator-gate-threshold <value>` when the evaluator does not return a pass decision

The gate metric must name one of the configured scorers. If the external evaluator is unavailable, the pipeline warns and uses the built-in judge. If a reachable evaluator run fails or omits required case results, the pipeline records the missing assessments instead of fabricating scores.

See [Commands](commands.md) for the complete option text and [Getting started](getting-started.md) for provider setup.
