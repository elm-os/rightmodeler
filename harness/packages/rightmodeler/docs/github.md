# GitHub

Three commands talk to GitHub. `apply` opens a draft pull request that changes model identifiers only and carries an evidence table. `watch` reconciles one of those pull requests per run. `rollback` opens a draft pull request that restores a merged swap. The CLI never merges a pull request: a person reviews and merges.

## Tokens

Pass the name of the environment variable that holds the token with `--github-token-env`, never the token itself.

| Token                                                                    | What works                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub App installation token (recommended, and the one to use in CI)    | `apply` and `watch` fully.                                                                                                                                                                                                                                                                             |
| Classic personal access token, or `gh auth token`, with the `repo` scope | `apply` and `watch` fully.                                                                                                                                                                                                                                                                             |
| Fine-grained personal access token                                       | `apply` fully. `watch` works but cannot read check runs, so each pass prints the `github_checks_unavailable` warning and uses commit statuses only.                                                                                                                                                    |
| GitHub Actions `GITHUB_TOKEN`                                            | `apply` and `watch` when the job grants `contents: write`, `pull-requests: write` and `statuses: read` (add `checks: read` for check runs) and the repository allows GitHub Actions to create pull requests. CI on the pull requests it opens waits for approval, so prefer an App installation token. |

Give a GitHub App these repository permissions: Contents read and write, Pull requests read and write, Checks read, Commit statuses read, and Metadata read. Pull requests it opens are authored by `<app-slug>[bot]`.

Give a fine-grained personal access token access to the repository with Contents read and write, Pull requests read and write, Commit statuses read, and Metadata read. GitHub offers no check-run permission for these tokens.

Commenting on a pull request needs only Pull requests write, so neither token needs the Issues permission.

## API host

`--github-base-url` defaults to `https://api.github.com`. For GitHub Enterprise Server, pass its API URL, such as `https://github.example.com/api/v3`. Enterprise Server 3.21 or newer is needed, because the CLI sends REST API version `2026-03-10` and older servers answer every call with HTTP 400.

`--github-repo` defaults to the name of the directory given to `--repo` on `apply`, `watch` and `rollback`. Pass it when the directory name differs from the repository name on GitHub.

## Apply

`apply` needs:

- a completed `init` run whose report recommends at least one swap;
- local `HEAD` on a branch and equal to the evidence revision, and that branch on GitHub at the same revision (the branch becomes the pull request base);
- no uncommitted change to any file the swap touches.

`--dry-run` runs every check and reads GitHub but writes nothing. Its result lists the branch, title, body, files and reviewers it would use. The reviewer list is shown before the pull request author is removed, because the author is known only once the pull request exists.

Reviewers:

- Owners of each swapped file come from the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` that exists, and the last matching rule wins.
- A file with no matching rule falls back to its three most recent `git blame` authors, matched to GitHub users by commit email. Blame needs full history, so fetch with depth 0 in CI.
- At most five users and five teams are requested, and never the pull request author.
- If GitHub rejects the batch with HTTP 422, each reviewer is requested alone and the rejected ones are dropped.
- Team reviewers need a repository owned by an organization, and every reviewer needs access to the repository.
- GitHub does not request code owners on draft pull requests by itself, so every review request on the draft comes from `apply`.

The branch is `<prefix>swap-<family>-<digest prefix>`, where the prefix is the one most common among the repository's recent branches, or `rightmodeler/` when no branch has one. The title is `perf(models): swap <families>` when the repository uses conventional commits, and `Swap <families> models` otherwise. The body is the repository's pull request template, if it has one, followed by the `## Rightmodeler evidence` table: revision, corpus version, and per family the decision, evaluators, cascade status, worst-case bound, models, cost per case, latency, caps and case IDs. Case IDs are SHA-256 digests of the replayed cases, never prompts. With `--code-graph <path>`, a `## Code context (Graphify)` section for the swapped call sites follows the table; the owners it lists are never requested as reviewers.

Rerunning `apply` for the same evidence returns the same open pull request with `status: "existing"` and requests reviewers again only if the first attempt left no record of them.

## Refusal codes

A refusal exits `1` and prints a result with `status: "refused"` and one or more `reasons`, each with a `code`, a `message` and a `detail`.

Apply:

- `no_confirmed_recommendation`: no recommended family has confirmed or not-required cascade evidence.
- `release_gate_failed`: at least one release gate is not green.
- `inconsistent_evidence`: the selected families do not share one evidence revision, corpus and gate policy.
- `previously_rejected`: this evidence and swap set was previously rejected and needs new evidence before it can be proposed again.
- `stale_evidence`: the evidence revision does not match the repository `HEAD`, or the remote base moved beyond it; re-prove before applying.
- `detached_head`: the repository has no current branch to use as the pull request base.
- `dirty_worktree`: a file the swap touches has uncommitted changes; commit or stash them before applying.
- `stale_location`: a proposed swap no longer matches its scan-time file digest or no longer has one fresh source location.
- `diff_lint_failed`: the proposed diff changes something other than model identifiers.
- `formatter_blocked`: the repository's formatter changed content outside the proposed swap.
- `host_conventions_unreadable`: one or more repository instructions could not be read unambiguously.
- `invalid_repository_revision`: the evidence revision is not a 40- or 64-character lowercase hex object ID.
- `apply_branch_unowned`: the swap branch exists without a recorded apply start.
- `apply_branch_scope_mismatch`: the existing swap branch changes files outside its declared scope.
- `apply_resume_state_mismatch`: the recorded pre-apply state does not match the resumed change.
- `apply_restore_failed`: after a failed apply, a file on the swap branch could not be restored.

Rollback:

- `missing_remediation_evidence`: the pull request has no valid recorded apply evidence.
- `original_pr_not_merged`: only a merged swap pull request can be rolled back.
- `pre_apply_revision_unavailable`: the recorded pre-apply file revision is unavailable or does not match its digest.
- `post_apply_digest_mismatch`: the affected files no longer match the recorded post-apply state.
- `rollback_branch_unowned`: the rollback branch exists without a recorded rollback start or base revision.
- `rollback_branch_scope_mismatch`: the existing rollback branch changes files outside the recorded scope.
- `rollback_restore_mismatch`: the rollback did not restore the recorded pre-apply state.
- `rollback_restore_failed`: after a failed rollback, a file could not be restored to the base state.

## Watch

Each `watch` run makes one pass over one pull request under a lock kept in the store, so overlapping runs do not act twice. Run it on a schedule or from repository events. A pass:

- records a merge and ends watching;
- records a close without merge as a rejection and ends watching, after which `apply` refuses that swap with `previously_rejected`;
- answers each human review and comment once with the stored evidence for the families it names, else for the families in the file it comments on, else for every family in the pull request;
- marks families for re-proof when a reviewer requests changes, or when the base branch changes a swapped file, and says so in a comment; the re-proof itself happens on the next pipeline run;
- on a failing check run or commit status, comments once, and if a check with the same name fails again under a new run on the same head commit, closes the pull request.

Exit codes:

- `0`: nothing needed doing.
- `1`: the pass took an action, listed in the result's `actions`.
- `2`: another watcher holds the lock, or the store has no completed run. With `--output json` or `jsonl`, a held lock prints a result with `"status":"lock_held"` on standard output, while a missing run prints an error with code `stage_not_completed` on standard error and nothing on standard output.
- `10` or greater: runtime failure.

When GitHub refuses to list check runs with HTTP 403, the pass still reconciles reviews, comments, commit statuses, merges and base-branch changes, and prints the `github_checks_unavailable` warning. Fine-grained personal access tokens always cause it. To include check runs, use a GitHub App installation token with Checks read or a classic token with the `repo` scope.

## Rollback

`rollback --pr <number>` opens a draft pull request that restores the pre-apply contents of the files a merged swap changed. It refuses unless the original pull request merged, and a rerun returns the same rollback pull request.

See [Exit codes](exit-codes.md) and [Commands](commands.md) for every option.
