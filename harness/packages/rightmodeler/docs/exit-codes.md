# Exit codes

Rightmodeler reserves exit codes `0` through `3` for machine-readable outcomes. Runtime and command-line failures use `10` or greater.

## Pipeline commands

- `0`: the command completed and no recommendation is being reported. Planning and partial `--through` runs also return `0` when successful.
- `1`: a complete `init` or `report` found an actionable recommendation.
- `2`: the run needs input at a resumable boundary, such as missing traces, a cancelled trace prompt, provider configuration, required confirmation configuration, or a plan's usage limit (rerun after it resets).
- `3`: the cost budget was reached at a resumable boundary.
- `10` or greater: command-line or runtime failure.

## Apply

- `0`: changes were applied, or a dry run was clean.
- `1`: the change was refused by a machine gate.
- `2`: no completed run in the store (for example `stage_not_completed`); the JSON error on standard error names the remedy.
- `10` or greater: runtime failure.

See [GitHub](github.md) for tokens, reviewers and refusal codes.

## Rollback

- `0`: the rollback pull request was opened, or already exists.
- `1`: the rollback was refused by a machine gate.
- `10` or greater: runtime failure.

## Drift

- `0`: the drift check completed.
- `2`: `--traces` is missing.
- `10` or greater: runtime failure.

## Watch

- `0`: no action was required.
- `1`: review or continuous-integration actions were taken.
- `2`: another watcher holds the lock, or the store has no completed run. A held lock prints a result with `"status":"lock_held"` on standard output; a missing run prints an error such as `stage_not_completed` on standard error and nothing on standard output.
- `10` or greater: runtime failure.

Use `--output json` for one result object or `--output jsonl` for stage events followed by the result. Errors use the selected machine-readable mode on standard error. See [Commands](commands.md) for command-specific options.

## Error codes

- `active_corpus_usage_unavailable` (exit `2`): publish a corpus version built from traces that include token usage, then rerun.
- `ambiguous_trace_format` (exit `2`): pass a trace file that unambiguously matches one supported format.
- `budget_cap_refusal` (exit `3`): the run reached the cost boundary; raise `--max-cost-usd` to the cap named in the remedy and rerun.
- `coverage_gate_failed` (exit `2`): add matcher coverage for the listed AI dependency surfaces, or pass `--matchers <file>` with declarative matchers that close them.
- `empty_traces_directory` (exit `2`): point `--traces` at a directory containing `.json` or `.jsonl` trace files, or at a single trace file.
- `git_repository_has_no_commits` (exit `2`): create the first commit, then rerun the command.
- `invalid_catalog_reference` (exit `2`): pass `--catalog-reference` an http(s) URL or a readable file that returns an OpenAI-compatible `/models` document, or remove it, then rerun.
- `invalid_matchers_file` (exit `2`): fix the listed matcher definitions in the `--matchers` file and rerun.
- `invalid_modeb_config` (exit `2`): fix the named field in the `--modeb-config` file and rerun.
- `invalid_option` (exit `2`): correct the option and rerun; use `rightmodeler <command> --help` for accepted values.
- `invalid_policy_file` (exit `2`): fix the named field in the `--policy` file and rerun; `qualityFloor` must be greater than 0.8 and less than 1, `shortlistTop` a positive integer, `allowModels` and `denyModels` arrays of model ids.
- `invalid_pricing_file` (exit `2`): fix `--pricing-file` to map each model id to non-negative `input` and `output` USD per token and, optionally, a positive integer `maxOutputTokens`, then rerun.
- `judge_family_unknown` (exit `2`): the catalog's model ids name no vendor, so the built-in judge could share a vendor with the candidate or the recorded model; use a gateway whose ids carry their vendor (`vendor/model`), or grade with `--evaluator`.
- `missing_provider_configuration` (exit `2`): pass `--base-url <url>` and, if needed, `--api-key-env <environment-variable-name>` naming a populated variable.
- `missing_traces_path` (exit `2`): pass `--traces <path>` pointing to an existing trace file or directory.
- `mixed_trace_formats` (exit `2`): split the directory so every file uses the same trace format, or pass one file with `--traces`.
- `modeb_cloud_unavailable` (exit `2`): install the optional sandbox SDK and set its credentials, or set `"backend": "docker"` in the `--modeb-config` file, then rerun.
- `no_neutral_judge` (exit `2`): the catalog has no priced model from a vendor other than both the candidate's and the recorded model's, which the built-in judge needs; list or price one (a multi-vendor gateway, `--catalog-reference` or `--pricing-file`), or grade with `--evaluator`.
- `no_priced_candidates` (exit `2`): point `--base-url` at a catalog that publishes per-token pricing, pass `--catalog-reference <url>`, expose priced LiteLLM `GET /model/info`, or pass `--pricing-file <path>`, then rerun.
- `no_replayable_call_sites` (exit `2`): point `--repo` at a service with plain text completions, or add a matcher for a text call site, then rerun.
- `not_git_repository` (exit `2`): run the command again from a Git repository with at least one commit.
- `plan_usage_limit` (exit `2`): a plan you are signed in to reached its usage limit; rerun the same command after the reset time in the message, and completed replay and judge calls are kept and not repeated.
- `stage_not_completed` (exit `2`): run `rightmodeler init --through <stage>` first, then rerun the command.
- `unusable_trace_input` (exit `2`): the selected discovered trace could not be adapted; rerun and choose a different trace file.
- `usage_error` (exit `10`): the command line is invalid; `message` carries the parser text.
