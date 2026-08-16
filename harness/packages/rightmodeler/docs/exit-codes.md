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

## Watch

- `0`: no action was required.
- `1`: review or continuous-integration actions were taken.
- `2`: another watcher holds the lock.
- `10` or greater: runtime failure.

Use `--output json` for one result object or `--output jsonl` for stage events followed by the result. Errors use the selected machine-readable mode on standard error. See [Commands](commands.md) for command-specific options.
