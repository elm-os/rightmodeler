# GitHub Actions

This workflow runs rightmodeler in GitHub Actions with the job's built-in `GITHUB_TOKEN`. It needs no GitHub App and no personal access token.

## What it does

- Runs `init` every Monday and whenever a push to `main` changes `traces/`.
- Opens the draft pull request only when a person runs the workflow with `command=apply`.
- Runs `watch` every 6 hours on each swap pull request that is still being watched.
- Never merges. A person reviews and merges the draft.

## Setup

1. Let GitHub Actions open pull requests. In the repository settings, under Actions, General, Workflow permissions, turn on "Allow GitHub Actions to create and approve pull requests", or run `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true`. This is the only repository setting the workflow needs. In a repository owned by an organization, the organization must allow it first.
2. Set the repository variable `RIGHTMODELER_PROVIDER_BASE_URL` and the repository secret `RIGHTMODELER_PROVIDER_API_KEY`, for example with `gh variable set` and `gh secret set`.
3. Commit traces under `traces/`, or change `RIGHTMODELER_TRACES` and the `paths` filter together.
4. Change `main` if the default branch has another name, and adjust `RIGHTMODELER_MAX_COST_USD`.
5. Save the workflow below as `.github/workflows/rightmodeler.yml`.

Each job grants `GITHUB_TOKEN` only what its command needs: `apply` gets `contents: write` and `pull-requests: write`, and `watch` gets `contents: read`, `pull-requests: write`, `checks: read` and `statuses: read`. See [GitHub](github.md) for what each command does with them.

## The workflow

```yaml
name: rightmodeler

on:
  schedule:
    - cron: "17 5 * * 1"
    - cron: "43 */6 * * *"
  push:
    branches: [main]
    paths:
      - "traces/**"
  workflow_dispatch:
    inputs:
      command:
        description: Which rightmodeler command to run
        type: choice
        options: [init, apply, watch]
        default: init

permissions:
  contents: read

concurrency:
  group: rightmodeler-store
  cancel-in-progress: false

env:
  RIGHTMODELER_VERSION: "0.4.0"
  RIGHTMODELER_TRACES: traces
  RIGHTMODELER_MAX_COST_USD: "5"
  RM_ANNOTATE: |
    const { readFileSync } = require("node:fs");
    const data = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    const prop = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
    for (const file of process.argv.slice(1)) {
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value === null || typeof value !== "object") continue;
        if (value.event === "result") value = value.result;
        if (value.event === "warning") {
          console.log(`::warning title=${prop(`rightmodeler ${value.code}`)}::${data(value.message)}`);
        } else if (value.status === "refused" && Array.isArray(value.reasons)) {
          for (const reason of value.reasons) {
            console.log(`::error title=${prop(`rightmodeler ${reason.code}`)}::${data(reason.message)}`);
          }
        } else if (typeof value.code === "string" && typeof value.message === "string") {
          console.log(`::error title=${prop(`rightmodeler ${value.code}`)}::${data(`${value.message} Remedy: ${value.remedy ?? ""}`)}`);
        }
      }
    }

jobs:
  init:
    if: >-
      github.event_name == 'push' ||
      (github.event_name == 'schedule' && github.event.schedule == '17 5 * * 1') ||
      (github.event_name == 'workflow_dispatch' && inputs.command == 'init')
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .rightmodeler
          key: rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: rightmodeler-store-
      - id: init
        name: Find and prove cheaper models
        env:
          RIGHTMODELER_PROVIDER_BASE_URL: ${{ vars.RIGHTMODELER_PROVIDER_BASE_URL }}
          RIGHTMODELER_PROVIDER_API_KEY: ${{ secrets.RIGHTMODELER_PROVIDER_API_KEY }}
        run: |
          out="$RUNNER_TEMP/rightmodeler"
          mkdir -p "$out"
          npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" --version
          set +e
          npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" init \
            --traces "$RIGHTMODELER_TRACES" \
            --base-url "$RIGHTMODELER_PROVIDER_BASE_URL" \
            --api-key-env RIGHTMODELER_PROVIDER_API_KEY \
            --max-cost-usd "$RIGHTMODELER_MAX_COST_USD" \
            --output jsonl --repo "$GITHUB_WORKSPACE" \
            >"$out/init.jsonl" 2>"$out/init.err"
          code=$?
          set -e
          node -e "$RM_ANNOTATE" "$out/init.jsonl" "$out/init.err"
          report="$GITHUB_WORKSPACE/.rightmodeler/project/reports/report.md"
          if [ -f "$report" ]; then
            cp "$report" "$out/report.md"
            cat "$report" >>"$GITHUB_STEP_SUMMARY"
          fi
          case "$code" in
            0) echo "recommendation=false" >>"$GITHUB_OUTPUT" ;;
            1)
              echo "recommendation=true" >>"$GITHUB_OUTPUT"
              echo "::notice title=rightmodeler::A proven swap is ready. Run this workflow with command=apply to open the draft pull request."
              ;;
            *)
              echo "::error title=rightmodeler::init exited $code; the annotations above name the cause and the fix."
              exit 1
              ;;
          esac
      - if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: rightmodeler-init
          path: ${{ runner.temp }}/rightmodeler/
          if-no-files-found: ignore
      - if: always()
        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .rightmodeler
          key: rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}

  apply:
    if: github.event_name == 'workflow_dispatch' && inputs.command == 'apply'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .rightmodeler
          key: rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: rightmodeler-store-
      - id: apply
        name: Open the draft pull request
        env:
          RIGHTMODELER_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          out="$RUNNER_TEMP/rightmodeler"
          mkdir -p "$out"
          npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" --version
          run_apply() {
            npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" apply "$@" \
              --owner "$GITHUB_REPOSITORY_OWNER" \
              --github-repo "${GITHUB_REPOSITORY#*/}" \
              --github-base-url "$GITHUB_API_URL" \
              --github-token-env RIGHTMODELER_GITHUB_TOKEN \
              --output json --repo "$GITHUB_WORKSPACE"
          }
          for mode in dry-run apply; do
            set +e
            if [ "$mode" = "dry-run" ]; then
              run_apply --dry-run >"$out/$mode.json" 2>"$out/$mode.err"
            else
              run_apply >"$out/$mode.json" 2>"$out/$mode.err"
            fi
            code=$?
            set -e
            node -e "$RM_ANNOTATE" "$out/$mode.json" "$out/$mode.err"
            if [ "$code" -ne 0 ]; then
              echo "::error title=rightmodeler::apply ($mode) exited $code; the annotations above name the cause and the fix."
              exit 1
            fi
          done
          pr="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).prNumber' "$out/apply.json")"
          echo "pr-number=$pr" >>"$GITHUB_OUTPUT"
          echo "Draft pull request #$pr is open for review. rightmodeler never merges it." >>"$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: rightmodeler-apply
          path: ${{ runner.temp }}/rightmodeler/
          if-no-files-found: ignore
      - if: always()
        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .rightmodeler
          key: rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}

  watch:
    if: >-
      (github.event_name == 'schedule' && github.event.schedule == '43 */6 * * *') ||
      (github.event_name == 'workflow_dispatch' && inputs.command == 'watch')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      pull-requests: write
      checks: read
      statuses: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .rightmodeler
          key: rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: rightmodeler-store-
      - id: watch
        name: Reconcile open swap pull requests
        env:
          RIGHTMODELER_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          out="$RUNNER_TEMP/rightmodeler"
          mkdir -p "$out"
          npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" --version
          set +e
          npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" status --output json \
            --repo "$GITHUB_WORKSPACE" >"$out/status.json" 2>"$out/status.err"
          code=$?
          set -e
          node -e "$RM_ANNOTATE" "$out/status.err"
          if [ "$code" -ne 0 ]; then
            echo "::error title=rightmodeler::status exited $code"
            exit 1
          fi
          failed=0
          for pr in $(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).pullRequests.map((entry) => entry.prNumber).join(" ")' "$out/status.json"); do
            set +e
            npx --yes "rightmodeler@${RIGHTMODELER_VERSION}" watch --pr "$pr" \
              --owner "$GITHUB_REPOSITORY_OWNER" \
              --github-repo "${GITHUB_REPOSITORY#*/}" \
              --github-base-url "$GITHUB_API_URL" \
              --github-token-env RIGHTMODELER_GITHUB_TOKEN \
              --output json --repo "$GITHUB_WORKSPACE" \
              >"$out/watch-$pr.json" 2>"$out/watch-$pr.err"
            code=$?
            set -e
            node -e "$RM_ANNOTATE" "$out/watch-$pr.json" "$out/watch-$pr.err"
            case "$code" in
              0) ;;
              1) echo "::notice title=rightmodeler::watch acted on pull request #$pr" ;;
              2)
                held="$(node -p 'try { JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).status } catch { "" }' "$out/watch-$pr.json")"
                if [ "$held" = "lock_held" ]; then
                  echo "::warning title=rightmodeler::another watcher holds the lock for pull request #$pr; the next run retries"
                else
                  failed=1
                fi
                ;;
              *) failed=1 ;;
            esac
          done
          exit "$failed"
      - if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: rightmodeler-watch
          path: ${{ runner.temp }}/rightmodeler/
          if-no-files-found: ignore
      - if: always()
        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .rightmodeler
          key: rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}
```

## How it behaves

- **The store.** `.rightmodeler/` lives in the Actions cache. Each run saves it under a new key and restores the newest `rightmodeler-store-` entry. GitHub removes entries unused for 7 days, and the 6-hourly watch keeps the store in use. Anyone with read access to the repository can read cache contents and uploaded artifacts, so use this workflow in private repositories.
- **One run at a time.** All runs share one concurrency group. If a run is already waiting, a newly queued run replaces it, so dispatch again if yours was replaced.
- **Annotations.** Every error and warning the CLI prints becomes an annotation that names its code, and errors also carry the remedy. `init` adds the report to the job summary, and every job uploads its output files as an artifact.
- **Stale evidence.** If `main` moves between `init` and `apply`, `apply` refuses with `stale_evidence`. Run `init` again.
- **Other branches.** A dispatch from another branch works on that branch. It starts from the default branch's store, saves its own copy that only that branch's runs restore, and `apply` opens the draft against that branch.
- **The token.** The draft is authored by `github-actions[bot]`, and the owners of the swapped files are requested as reviewers. GitHub starts no workflow for a push made with `GITHUB_TOKEN`. For a pull request that `GITHUB_TOKEN` opens, GitHub creates the `pull_request` workflow runs in an approval-required state, and a person with write access starts them with "Approve workflows to run" on the pull request.
- **Schedules.** GitHub can delay scheduled runs at busy times, and disables schedules in public repositories after 60 days without activity.

## Optional: a GitHub App token

The workflow above runs on the built-in `GITHUB_TOKEN`, the supported default. A GitHub App installation token is an optional upgrade: the draft's `pull_request` workflows start without approval, and the draft is authored by `<app-slug>[bot]`. To use one:

1. Create a GitHub App with the permissions in [GitHub](github.md) and install it on the repository.
2. Store its client ID in the repository variable `RIGHTMODELER_APP_CLIENT_ID` and its private key in the repository secret `RIGHTMODELER_APP_PRIVATE_KEY`.
3. In the `apply` and `watch` jobs, add this step before the rightmodeler step, and change that step's `RIGHTMODELER_GITHUB_TOKEN` to `${{ steps.app-token.outputs.token }}`:

   ```
   - id: app-token
     uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
     with:
       client-id: ${{ vars.RIGHTMODELER_APP_CLIENT_ID }}
       private-key: ${{ secrets.RIGHTMODELER_APP_PRIVATE_KEY }}
   ```

## Cloud Mode B

To confirm in Vercel Sandbox, add `--modeb-config <file>` to the `init` command and map the `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` secrets into that step's `env`. See [Mode B](modeb.md).

## Upgrading

Change `RIGHTMODELER_VERSION`. Each rightmodeler step first runs the CLI with `--version`, so a version npm cannot install fails the step with npm's error in its log instead of being mistaken for a rightmodeler exit code. Each release's copy of this guide pins that release, and `rightmodeler docs github-actions` prints the copy for the installed version.
