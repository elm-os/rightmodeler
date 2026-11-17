# CI latency: where the time goes and what to change

Status: research memo with changes, written 2026-11-16. Line references are to the repository
as it stood on that date.
Scope: the `ci` workflow (`.github/workflows/ci.yml`) on GitHub-hosted runners. The baseline is
the last 60 completed runs, 199 to 258 (2026-10-13 to 2026-11-01). The changes were measured on
branch `aakash/ci-quick-wins` (pull request #108).

## Summary

The `windows` job sets the wall time of every pull request and every `main` push, and one test
file, `harness/packages/rightmodeler/src/e2e.test.ts`, is 83% of that job. No configuration
change touches that; splitting the file does, and it is the first of the larger items below.
This branch takes the smaller changes the measurements support:

- **The agent check runs alongside the CLI suite** (`harness/apps/agent/turbo.json`). The serial
  tail after `cli:check` fell from a median 41s on Windows and 21s on Linux to 0s in every branch
  run.
- **No duplicate type check** (five `check` scripts). The CLI suite starts 8 to 9s sooner.
- **No `ci` run for tag pushes.** A release tag no longer reruns a full Linux and Windows run
  (median 24m38s of wall time over the last three tags) on a commit `main` has normally checked
  already.
- **Windows TEMP on D:.** In two same-run pairs the CLI suite did 27% and 28% less work per unit
  of runner speed; on comparable runners it finished 4m12s sooner.
- **pnpm from npm on Windows.** 7 to 10s instead of a 22s median.
- **No pnpm store cache on Windows.** setup-node takes 4 to 6s instead of 18s, and no 13s cache
  save follows a miss.

On Windows, checkout, Node.js, pnpm and install now take 28 to 40s instead of 58s. One proposed
change was measured and dropped: a BuildKit layer cache for the Mode B fixture image took 19s and
31s warm, and 44s and 68s cold, against 28s without it.

## Method

- Job and step timings come from the GitHub Actions Jobs API: queue is `created_at` to
  `started_at`, and a step is its `started_at` to `completed_at`.
- Task timings come from job logs. In Actions, turbo prints a task's output as one group when the
  task finishes, so the group's timestamp is the task's finish time. Offsets are from the start
  of `turbo run check`.
- Test phases come from vitest's `Start at` and `Duration` lines, and per-file durations from its
  default reporter.
- Runners are the standard hosted `ubuntu-24.04` and `windows-2025-vs2026` images, 4 vCPU each.
  vitest's forks pool defaults to `availableParallelism() - 1` workers outside watch mode, so 3
  per suite (vitest 3.2.7, `dist/chunks/coverage.DfSpMS-b.js`, `createForksPool`).
- Branch runs were measured with the same scripts, each attempt kept separately. Medians are over
  successful jobs.

## Measured anatomy

### Job phases, runs 226 to 258 (the current workflow shape)

Median / p90.

| phase                          | ci (n=22)       | windows (n=21)  | unprivileged-artifacts (n=10) |
| ------------------------------ | --------------- | --------------- | ----------------------------- |
| queue                          | 3s / 4s         | 3s / 4s         | 3s / 3s                       |
| checkout                       | 2s / 2s         | 6s / 9s         | 2s / 2s                       |
| set up pnpm                    | 5s / 6s         | 22s / 30s       | 5s / 6s                       |
| set up Node.js (cache restore) | 6s / 8s         | 18s / 21s       | 6s / 7s                       |
| pnpm install                   | 6s / 8s         | 12s / 19s       | 6s / 6s                       |
| Docker fixture prebuild        | 28s / 32s       | none            | 30s / 32s                     |
| setup total                    | 47s / 52s       | 59s / 1m11s     | 50s / 52s                     |
| `pnpm check`                   | 18m06s / 18m51s | 22m20s / 25m20s | 18m27s / 18m52s               |
| job total                      | 18m58s / 19m42s | 23m24s / 26m38s | 19m22s / 19m46s               |

A same-repository pull request starts two runs on one commit: the `push` run (`ci` and
`windows`) and the `pull_request` run (`unprivileged-artifacts`, then `guarded-live`). Wall time
per pushed commit since run 226:

| event                  | n   | median | p90    | last job to finish  |
| ---------------------- | --- | ------ | ------ | ------------------- |
| same-repo pull request | 9   | 23m54s | 25m56s | `windows` in 9 of 9 |
| `main` push            | 8   | 22m40s | 25m39s | `windows` in 8 of 8 |
| tag push               | 3   | 24m38s | 26m16s | `windows` in 2 of 3 |

### Inside `pnpm check`, runs 199 to 258

Offsets from the start of turbo, median / p90.

| point                                            | ci (n=37)       | windows (n=21)  |
| ------------------------------------------------ | --------------- | --------------- |
| `core:build` finished                            | 9s / 10s        | 10s / 10s       |
| `replay:build` finished                          | 42s / 45s       | 45s / 48s       |
| `cli:build` finished                             | 1m06s / 1m12s   | 1m19s / 1m24s   |
| `replay:check` finished                          | 3m01s / 3m12s   | 1m50s / 1m54s   |
| `^check` wait (replay:check end - cli:build end) | 1m54s / 2m01s   | 29s / 32s       |
| CLI `tsc --noEmit` before vitest                 | 8s / 9s         | 9s / 10s        |
| CLI vitest started                               | 3m08s / 3m20s   | 1m58s / 2m05s   |
| CLI vitest wall                                  | 13m28s / 15m02s | 19m30s / 22m38s |
| of which `src/e2e.test.ts`                       | 13m27s / 15m00s | 19m27s / 22m36s |
| `cli:check` finished                             | 16m37s / 18m24s | 21m36s / 24m37s |
| `agent:check` after `cli:check`                  | 21s / 23s       | 41s / 46s       |

The CLI suite has 62 files. `e2e.test.ts` holds 121 tests that run one after another in a single
worker, so it sets the suite's wall time on both systems. On Linux one Docker test in it, the
Mode B confirmation and frontier resume, takes a median 384s (p90 409s, 56 jobs); it is the floor
for any split there. On Windows the Docker tests skip and no single test dominates: 113 listed
tests total about 19 minutes. Compared test by test with Linux, Windows is 3.0 to 5.2 times
slower while the other two workers are busy with the remaining 61 files, and 1.7 to 2.3 times
slower once `e2e.test.ts` runs alone, which puts CPU contention at about 1.3 to 1.8 times per
test.

### Caches

- The pnpm store is cached by `actions/setup-node` (`cache: pnpm`), keyed on the lockfile hash,
  about 200 MB. In runs 199 to 258 it hit in 39 of 41 Linux `push` jobs and 17 of 23 Windows
  jobs. In the 18 jobs of runs 259 to 273 it missed 17 times: GitHub removes entries not
  accessed in over 7 days, those runs followed a two-week pause, and the lockfile changed once.
- turbo runs without a remote cache, and a fresh runner has no local one, so all tasks execute
  every time. Build task hashes are identical on Linux and Windows. Check task hashes differ only
  because `check` declares `env: ["RIGHTMODELER_SKIP_DOCKER"]`, which only the Windows job sets.

## Critical path

The `windows` job is the critical path of every pull request and `main` push since it landed.
Its median timeline before this branch:

```
queue 3s
setup 59s: set up pnpm 22s, set up Node.js with cache restore 18s, install 12s, checkout 6s
turbo: core:build 10s, then kernel, executor and scanner builds, replay:build at 45s,
       cli:build at 1m19s
wait for replay:check through ^check, 29s
CLI tsc --noEmit, 9s
CLI vitest 19m30s, of which e2e.test.ts 19m27s
agent:check 41s, waiting for cli:check through ^check
bundle check 1s, post steps 3s
```

The `pull_request` run ends a median 4m19s before the push run's `windows` job, and the Linux
`ci` job about 4.5 minutes before it. Before this branch, Linux savings shortened runner time but
not the wall time a developer waits. With it, the two jobs are close: in the final run below,
`ci` finished at 15m46s and `windows` at 12m36s, so the Linux job, with its 384s Mode B test, can
now be the last to finish.

## What this branch changes

### How it was measured

The measured commit (`6890fd1`) ran as push run 43987351219 and pull_request run 43987358485,
each twice (attempt 1, then a rerun). In that commit the `windows` job ran as two legs on the
same code, one with TEMP on C: (the runner default) and one with TEMP on `runner.temp` (D:), and
a scratch workflow (run 43987351424, four attempts) timed four ways to install pnpm on Windows.
The final commit removes both. Every job of every attempt passed.

Absolute job times are not a fair before and after. Recent `main` and branch runs on this code
(runs 259 to 273, the same 786 tests) had medians of 13m14s for `ci` and 18m11s for `windows`,
against 18m58s and 23m24s in the baseline window: runner speed varies a lot from run to run. The
effects below are therefore read from task offsets, same-run pairs and individual steps, and the
job totals are given only for completeness.

| step or point                         | baseline median   | branch runs                 |
| ------------------------------------- | ----------------- | --------------------------- |
| Windows: set up pnpm                  | 22s               | 9s, 7s, 9s, 10s             |
| Windows: set up Node.js               | 18s               | 5s, 4s, 6s, 4s              |
| Windows: install                      | 12s (cache hit)   | 15s, 12s, 17s, 20s          |
| Windows: post steps                   | 3s; 13s on a miss | 3s, 2s, 2s, 2s              |
| Windows: checkout to install, summed  | 58s               | 36s, 28s, 39s, 40s          |
| tail after `cli:check`, Linux         | 21s               | 0s in all four Linux jobs   |
| tail after `cli:check`, Windows       | 41s               | 0s in all four Windows jobs |
| CLI `tsc` before vitest               | 8s Linux, 9s Win  | 0 to 1s in all eight        |
| `pnpm check`, ci                      | 18m06s            | 11m31s, 11m47s              |
| `pnpm check`, Windows TEMP on C:      | 22m20s            | 17m36s, 14m54s              |
| `pnpm check`, Windows TEMP on D:      | 22m20s            | 13m22s, 15m47s              |
| job total, ci                         | 18m58s            | 13m28s, 12m38s              |
| job total, Windows TEMP on D: (final) | 23m24s            | 14m05s, 16m33s              |

Windows rows list attempt 1 and attempt 2 of the C: leg, then of the D: leg, where both legs ran.

The final configuration then ran on commit `04f8120`, as push run 43993344295 and as
pull_request run 43993353474, and passed: `windows` took 12m36s, with 33s from checkout to
install, a 1s CLI `tsc` gap, a 0s tail and `bundle.test.ts` at 26.2s; `ci` took 15m46s and
`unprivileged-artifacts` 13m14s. Its Check step's environment showed TEMP and TMP as
`D:\a\_temp`.

### The agent check alongside the CLI suite

`@rightmodeler/agent#check` reached `@rightmodeler/cli#check` only through the generic `check`
task's `^check`. A package configuration, `harness/apps/agent/turbo.json`, extends the root and
sets only `"check": { "dependsOn": ["build", "^build"] }`. `turbo run check --dry=json` differs
from `main` in one edge, `agent#check` no longer depends on `cli#check`, and in the new file
counting as one more input of the agent's tasks. Its `env`, `inputs`, `outputs` and cache settings
resolve as before.

A root `package#task` entry would also have worked, but it replaces the generic task instead of
merging with it, so it would have to copy `check`'s `env` and `inputs` and would miss later
changes to them. A dry run with a dummy variable added to `check`'s `env` and a dummy glob added
to its `inputs` shows the difference: through the package configuration both reach `agent#check`;
through a root `@rightmodeler/agent#check` entry neither does, while `core#check` gets both.

The agent still waits for `cli:build`. During the CLI suite, `bundle.test.ts` runs `pnpm pack`,
whose `prepack` reruns `build.mjs`; that script builds into `dist-bundle.staging` and renames each
file into `dist-bundle`, and the CLI's own `runbook` and `github-actions-doc` tests already spawn
`dist-bundle/cli.js` while that happens. The evals use their own temporary store, an ephemeral
stub-provider port and Mode A only, so they start no Docker containers and are untouched by the
Mode B reaping described under item 4 below.

Overlapped, the agent check takes longer: 28s to 36s on Linux (21s to 23s before) and 59s to
1m26s on Windows (41s before); the evals themselves took 13s to 17s and 38s to 60s, against a
120s per-eval timeout. agent:check now finishes 1m16s to 2m46s into turbo, while the CLI suite
runs.

### No duplicate type check

In core, executor, kernel, scanner and the CLI, `build` runs `tsc -p tsconfig.json` over all of
`src/`, tests included, and `check` depends on `build`, so `check`'s `tsc --noEmit` repeated a
type check that had just passed on the same configuration. For each of the five packages, a type
error added to a test file fails `turbo run build --filter=<package>` with TS2322. replay builds
with a configuration that excludes tests, and the agent builds with eve, so both keep their type
check, and `check-types` still type-checks any package on its own. `release.yml` builds the CLI
with turbo before it runs the CLI's `check`, so a release still type-checks.

### No `ci` run for tag pushes

A `push` trigger that lists only `branches` does not run for tags, and `**` matches branch names
that contain `/`. Tag runs repeated a commit `main` had already checked for v0.6.2, v0.6.1, v0.6.0
and v0.4.0. For v0.5.0, `main`'s run was cancelled, and the tag run was the only full result.
`release.yml` still builds and checks the CLI package on every `v*` tag, on Linux only, so the
Windows suite and the other packages' suites now rely on `main`'s run for the tagged commit.

### Windows TEMP on D:

The workspace and `runner.temp` are on D: on the hosted Windows image, and TEMP defaults to C:.
The two legs of each attempt ran the same commit at the same time:

| attempt | CPU-bound suites, D:/C: | CLI test work, D:/C: | CLI work per runner speed | `bundle.test.ts` C: to D: |
| ------- | ----------------------- | -------------------- | ------------------------- | ------------------------- |
| 1       | 0.94                    | 0.69                 | 0.73                      | 71.8s to 31.9s            |
| 2       | 1.37                    | 0.98                 | 0.72                      | 75.0s to 37.5s            |

The CPU-bound suites (core, kernel, scanner and replay) stand in for the speed of the two
runners. They also create temporary directories (21 of their 43 test files call `tmpdir()`), so
to the extent they gain from D: as well, dividing by their ratio understates the CLI suite's
gain. In attempt 1 the runners matched, and the CLI suite's wall time fell from 16m19s to
12m07s. In attempt 2 the D: leg drew a runner about 37% slower, and still did slightly less CLI
work than the C: leg. The files that gain most create temporary git repositories or install
packages: `apply/diff.test.ts` went from 15.1s to 0.6s in attempt 1. The scratch workflow points
the same way: pnpm/action-setup's `npm ci` of its 891-file bootstrap took 19s into
`C:\Users\runneradmin\setup-pnpm` and 4s into `D:\a\_temp\setup-pnpm`.

With both on D:, the e2e tests that pass the repository's promptfoo fixture to the CLI no longer
take the cross-drive branch of the promptfoo scratch folder (`scratchParent` in
`evaluators/promptfoo.ts`), which is where a real bug was once found. A dedicated test,
`evaluators/promptfoo-cross-drive.test.ts`, restores that coverage. On Windows it points TEMP at a
fresh folder in the default TEMP on the system drive, runs the promptfoo stub on the repository's
assertions, and checks that the model outputs were written under the assertions' `.rightmodeler`
folder through a relative path and then removed. It skips when both are on one drive. With
`scratchParent` patched to always return TEMP, it fails with the old symptom: the stub cannot open
a model-outputs path joined across drives.

### pnpm from npm on Windows

pnpm/action-setup v6.0.10 installs a bootstrap pnpm pinned in its own lockfile (11.19.0, 891
files, 36.7 MB) with `npm ci`, then runs `pnpm self-update` to the `packageManager` version
(11.7.0, 449 files). On Windows the job now runs setup-node first and then
`npm install --global pnpm@<packageManager>`, so the version still comes only from the
`packageManager` field. Scratch timings for the step, four attempts each:

| variant                              | seconds        | median |
| ------------------------------------ | -------------- | ------ |
| action, defaults                     | 31, 17, 24, 26 | 25s    |
| action, `standalone: true`           | 27, 26, 23, 29 | 26.5s  |
| action, `dest` under `runner.temp`   | 12, 12, 12, 13 | 12s    |
| `npm install --global` (this branch) | 8, 13, 7, 8    | 8s     |

`standalone: true` installs `@pnpm/exe`, whose Windows binary package (`@pnpm/win-x64`, 98 MB
unpacked at 11.7.0) it downloads once for the bootstrap and again for the self-update. The Linux
jobs keep pnpm/action-setup, about 5s there, because their setup-node step restores the pnpm
store cache and needs pnpm installed before it runs.

### No pnpm store cache on Windows

setup-node only auto-caches for npm, so dropping `cache: pnpm` turns the store cache off. On a
hit, restoring the 200 MB store took most of setup-node's 18s (tar extraction alone took 11.4s in
run 257), and install took 12s; on a miss, install took 18.5s and the post step spent 13.5s
saving the cache. Without the cache, setup-node took 4 to 6s and install 12 to 20s. Every Windows
run now downloads its packages from the npm registry; the Linux jobs keep the cache.

### Dropped: a BuildKit layer cache for the Mode B fixture image

The prebuild was moved to docker/setup-buildx-action and docker/build-push-action with
`cache-from` and `cache-to` set to `type=gha`, kept the requirements digest as the image tag, and
checked with `docker image inspect` that the image reached the daemon.

| job                    | cold (attempt 1)     | warm (attempt 2)     | baseline |
| ---------------------- | -------------------- | -------------------- | -------- |
| ci                     | 17s + 51s, about 68s | 11s + 7s, about 19s  | 28s      |
| unprivileged-artifacts | 12s + 31s, about 44s | 13s + 17s, about 31s | 30s      |

The first number is setting up the builder, the second the build. Setting up a
`docker-container` builder costs 11 to 17s on its own: 4 to 6s of `docker version` and
`docker info`, a pull of the buildkit image and a container start. The runner's Docker Engine
28.0.4 uses the classic overlay2 image store, so even a fully cached build must export the image
as a tarball and load it, 5 to 13.5s. That leaves at most 10s of the 15s that apt and pip take,
and a cold cache, after every new `node:24-bookworm-slim` digest and in every new cache scope,
costs 14 to 40s more. Each warm figure is a single sample. Now that the Linux job can finish last,
a dependable Linux saving would count toward wall time, so this is worth retrying with
`docker save` and `docker load` through `actions/cache` keyed on `requirements.txt`, which would
match how a developer machine reuses the image, or with the containerd image store.

## Plan for the larger items

Work on items 1 to 4 had started on separate branches when this note was written.

### 1. Split `e2e.test.ts`

This is the only item that moves the wall time by minutes. A list-scheduling simulation over
the real per-test durations of run 257 (run 258 for Linux), splitting the file by `describe`
and cutting the long "built CLI pipeline" block into contiguous slices, gives these floors.
They assume no extra contention, so they are lower bounds, not forecasts.

| scenario                                                     | CLI suite wall      |
| ------------------------------------------------------------ | ------------------- |
| Windows today, measured                                      | 19m30s              |
| Windows split, 3 workers, longest first                      | 10m18s              |
| Windows split, 3 workers, vitest's largest-file-first order  | 10m42s              |
| Windows split, with the 1.3 to 1.8 contention factor         | about 12m to 14m30s |
| Linux today, measured                                        | 15m01s              |
| Linux split, Mode B tests in their own file, scheduled first | 7m47s               |
| Linux split, Mode B file left in size order                  | 11m05s              |

The Linux result depends on the Mode B file starting first, because its single 384s test is
the floor. vitest orders files by its cache of previous durations when it has one and by file
size otherwise, so on a fresh runner the order needs `sequence` configuration or a dedicated
project.

### 2. A turbo task cache seeded by `main`

Every run executes every task, because runners start empty. If `main` saved turbo's cache and
other runs restored it, a pull request that leaves a task's inputs unchanged would replay that
task's result instead of running it. Four of the last twelve merged pull requests (#99, #100,
#101 and #105) changed only the website, docs, `AGENTS.md` or the website's lockfile entries;
their harness checks, most of the Windows job, would have replayed, provided turbo attributes
such lockfile changes to `apps/web` alone.

- Write the cache only from `main` and restore it everywhere, so a pull request cannot plant
  results that `main` then trusts. Actions caches restore from the current branch, the default
  branch and, for a pull request, its base branch; the repository limit is 10 GB.
- Build hashes already match across systems, and check hashes are per system through
  `RIGHTMODELER_SKIP_DOCKER`, which is the separation the Docker suites need.
- A hash covers inputs, the environment variables listed in `env` and dependency hashes, not the
  state of Docker or the network. Tests that depend on the outside world would replay a stale
  pass; those inputs need to be declared, or those tasks kept out of the cache.

### 3. TypeScript 7

With this branch, `tsc` runs once per package, inside `build`, and the builds before the CLI
suite starts take about 1m20s on Windows (`cli:build` finishes at 1m19s). The native TypeScript
compiler could shorten that phase. The first step is to measure `tsc`'s share of each build
against the esbuild bundle and docs check in `cli:build`, then try the native compiler on the
build scripts and compare the emitted declarations before switching.

### 4. Let the Docker suites overlap

`cli:check` depends on `^check`, so it waits for `replay:check`, which waits for
`executor:check`. On Linux that wait is 1m54s after `cli:build`; on Windows, without Docker, 29s.
The chain exists because Mode B containers reap each other across suites:

- the executor test "reaps old executor containers" calls `reapOrphans({ olderThanMs: 0 })`;
- replay's driver tests run Mode B with a 2s app timeout, which reaps every container labelled
  `com.rightmodeler.executor=1` older than 12s;
- the CLI's Mode B containers can live up to 70s.

Scoping each reap to a per-run label, and only then dropping `^check` from `cli#check`, would
let the CLI suite start about 1m54s earlier on Linux and 29s earlier on Windows.

### 5. Larger or sharded Windows runners

The simulation puts the split suite at 4m29s to 4m35s on 7 workers, that is, an 8-vCPU runner
without contention. Two ways to get there:

- a larger hosted runner, which costs more per minute and needs a plan that offers them;
- sharding the split suite across several standard Windows jobs with `vitest --shard`, which
  repeats setup (28 to 40s with this branch) and the build phase (about 1m in these runs) in
  every shard.

Both make sense only after the split, because one file cannot be sharded.

## Examined and not changed

- **turbo concurrency against cores.** turbo runs up to 10 tasks at once by default on these
  4-vCPU runners, and each vitest suite starts 3 workers, so the first two minutes are
  oversubscribed. turbo has no task priorities, and a lower limit would queue the critical builds
  behind the website tasks.
- **More vitest workers.** `e2e.test.ts` runs in one worker whatever the pool size; this pays
  only after the split.
- **pnpm's supply-chain verification.** "Verifying lockfile against supply-chain policies (724
  entries)" takes 5.1s of the 6s Linux install and 7.7s on Windows. It is a security control,
  not overhead to cut quietly.
- **The second Linux suite per same-repository pull request.** The `push` run's `ci` job and
  the `pull_request` run's `unprivileged-artifacts` job both run the full Linux check. The second
  feeds `guarded-live`; it costs runner time, not wall time.
- **setup-node's environment report.** It takes about 5s on Windows, and v7.0.0 always runs it.
- **The Windows checkout.** In run 257, 3.4s of its 8.6s went to checkout's own credential
  setup, which spawns `git submodule foreach` through `sh`, and 2.2s to the fetch. Not pursued.
- **Other writes to C: on Windows.** npm's cache (which `bundle.test.ts` uses for its tarball
  install), pnpm's metadata cache and the home directory are still on C:. Each could move to D:
  the same way, but none was measured.

## What was read, and how

- Run, job and step data: the GitHub Actions REST API (`actions/runs`,
  `actions/runs/{id}/attempts/{n}/jobs`, `actions/jobs/{id}/logs`) for runs 199 to 258, the
  `main` and branch runs 259 to 273, and the runs of pull request #108.
- turbo 2.10.2 behaviour: the configuration reference,
  https://turborepo.dev/docs/reference/configuration, the run reference,
  https://turborepo.dev/docs/reference/run (`--concurrency` defaults to 10), and the package
  configurations page,
  https://turborepo.dev/docs/reference/package-configurations, which states that a root
  `package#task` entry overwrites the generic task's configuration instead of inheriting it.
  `turbo run check --dry=json` confirmed it: a bare override resolves `env` and `inputs` to empty.
- GitHub Actions: the workflow syntax reference,
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax (a `push`
  trigger that defines only `branches` does not run for tags; `**` matches `/`); the contexts
  reference, https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
  (`runner` is available in a step's `env` but not in a job's `env`); and the dependency caching
  reference, https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching
  (entries unused for 7 days are removed, 10 GB per repository, which branches a run can restore
  from).
- Action sources at the commits the workflows pin:
  - pnpm/action-setup `0977fd99725f1db4007ccb2928dbb4e90d06cc86` (v6.0.10): `action.yml`,
    `src/install-pnpm/run.ts`, `src/inputs/index.ts` and
    `src/install-pnpm/bootstrap/pnpm-lock.json`,
    https://github.com/pnpm/action-setup/tree/0977fd99725f1db4007ccb2928dbb4e90d06cc86
  - actions/setup-node `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0): `action.yml` and
    `src/main.ts`, https://github.com/actions/setup-node/tree/820762786026740c76f36085b0efc47a31fe5020
  - docker/setup-buildx-action `f87e5991a6d7451dcb8d9637bfbc97413f497069` (v4.4.1) and
    docker/build-push-action `c3c9e263c25d99ce0380d002d59b67737d91b0dc` (v7.4.0): their READMEs,
    https://github.com/docker/setup-buildx-action/tree/f87e5991a6d7451dcb8d9637bfbc97413f497069
    and https://github.com/docker/build-push-action/tree/c3c9e263c25d99ce0380d002d59b67737d91b0dc
- npm registry metadata for `pnpm@11.7.0`, `pnpm@11.19.0`, `@pnpm/exe@11.7.0` and
  `@pnpm/win-x64@11.7.0` (file counts and unpacked sizes), read with `npm view`.
- vitest 3.2.7 as installed in `harness/packages/rightmodeler/node_modules`, for the default
  worker count (`createForksPool`) and the default file order (`BaseSequencer.sort`: failed
  files, then longer cached durations first, and largest file first without a cache).
- The repository at the commit this branch is based on (`5f59d5c`): `.github/workflows/`,
  `turbo.json`, the package manifests and tsconfigs, `harness/packages/rightmodeler/build.mjs`,
  the agent evals in `harness/apps/agent/`, and the tests named above.
