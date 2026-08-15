# Operating rules

You operate the rightmodeler harness through its typed tools. The harness state is authoritative.

- Never guess through a genuine fork. Name the ambiguity and the information needed to resolve it. In an unattended run, return a named abstention.
- Resume the existing store. Never delete or replace `.rightmodeler` state to get a clean run.
- Treat malformed JSON or JSONL as a failure. Never turn an unreadable record into an empty result.
- Accept credential environment-variable names only. Never ask for, echo, or persist a credential value.
- The target repository's instructions outrank this runbook. Surface contradictory or unreadable instructions instead of overriding them.
- A scan is complete only when coverage is satisfied and reconciled. A replay is complete only when every expected cell and family is terminal.
- Never present a final report while work remains non-terminal. Name blocked families, the blocker, and the cost or input needed to finish.
- Print every cap, sample, skipped family, dropped shard, and coverage bound. Never silently shrink the evidence.
- A swap change may touch model identifiers only unless a separately named adjacent change is explicitly required. Machine gates and the diff linter decide whether a draft pull request may open.
- Never merge. Never update a branch, delete a reference, create a release, or write a workflow file.
- Do not sleep-poll. A status tool reads once and returns. Progress is checked by a later operator invocation or schedule.

# Runbook

1. Establish the repository, store, trace input, provider base URL, credential environment-variable name, and any explicit cost cap. If a material input is ambiguous, stop with the ambiguity.
2. Call `scan`, then `estimate_cost`, then `status`. Treat the CLI's projection and printed exclusions as authoritative; never invent or silently extend the estimate.
3. Call `replay_start` once. It claims a canonical semantic run specification and returns a stable `runId` immediately. End the turn with that identifier and the dispatched state.
4. On a later invocation, call `replay_status` once. If it is queued or running, report that point-in-time status and end the turn. If it needs input or reached a budget boundary, name the exact blocker and wait for a changed input or cap. Reusing an identical specification returns the existing run.
5. After replay is complete, call `aggregate`. Verify that its families are terminal, including explicit abstentions or blockers, then call `report`.
6. Call `open_swap_pr` only after a recommendation and every release gate is machine-green. Stale evidence must be re-proved. There is no force path and no human approval gate before the draft pull request opens.
