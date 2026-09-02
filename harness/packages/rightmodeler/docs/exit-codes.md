# Exit codes

Rightmodeler reserves exit codes `0` through `3` for machine-readable outcomes. Runtime and command-line failures use `10` or greater.

## Pipeline commands

- `0`: the command completed and no recommendation is being reported. Planning and partial `--through` runs also return `0` when successful.
- `1`: a complete `init` or `report` found an actionable recommendation.
- `2`: the run needs input at a resumable boundary, such as missing traces, a cancelled trace prompt, provider configuration, or required confirmation configuration.
- `3`: the cost budget was reached at a resumable boundary.
- `10` or greater: command-line or runtime failure.

## Apply

- `0`: changes were applied, or a dry run was clean.
- `1`: the change was refused by a machine gate.
- `10` or greater: runtime failure.

## Drift

- `0`: the drift check completed.
- `2`: `--traces` is missing.
- `10` or greater: runtime failure.

## Watch

- `0`: no action was required.
- `1`: review or continuous-integration actions were taken.
- `2`: another watcher holds the lock.
- `10` or greater: runtime failure.

Use `--output json` for one result object or `--output jsonl` for stage events followed by the result. Errors use the selected machine-readable mode on standard error. See [Commands](commands.md) for command-specific options.

## Error codes

- `usage_error` (exit `10`): the command line is invalid; `message` carries the parser text.
- `missing_traces_path` (exit `2`): pass `--traces <path>` pointing to an existing trace file or directory.
- `empty_traces_directory` (exit `2`): point `--traces` at a directory containing `.json` or `.jsonl` trace files, or at a single trace file.
- `mixed_trace_formats` (exit `2`): split the directory so every file uses the same trace format, or pass one file with `--traces`.
- `invalid_option` (exit `2`): correct the option and rerun; use `rightmodeler <command> --help` for accepted values.
- `invalid_modeb_config` (exit `2`): fix the named field in the `--modeb-config` file and rerun.
- `invalid_pricing_file` (exit `2`): fix `--pricing-file` to map each model id to non-negative `input` and `output` USD per token and, optionally, a positive integer `maxOutputTokens`, then rerun.
- `invalid_policy_file` (exit `2`): fix the named field in the `--policy` file and rerun; `qualityFloor` must be greater than 0.8 and less than 1, `shortlistTop` a positive integer, `allowModels` and `denyModels` arrays of model ids.
- `invalid_matchers_file` (exit `2`): fix the listed matcher definitions in the `--matchers` file and rerun.
- `no_replayable_call_sites` (exit `2`): point `--repo` at a service with plain text completions, or add a matcher for a text call site, then rerun.
- `no_priced_candidates` (exit `2`): point `--base-url` at a catalog that publishes per-token pricing, expose priced LiteLLM `GET /model/info`, or pass `--pricing-file <path>`, then rerun.
- `stage_not_completed` (exit `2`): run `rightmodeler init --through <stage>` first, then rerun the command.
