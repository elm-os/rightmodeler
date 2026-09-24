import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { narrowFixtureForApply } from "./test-utils/apply-fixture.js";
import { commitGitFixture, makeGitFixture } from "./test-utils/git-fixture.js";

const missing = [
  ...(process.env.RIGHTMODELER_LIVE_GITHUB === "1"
    ? []
    : ["RIGHTMODELER_LIVE_GITHUB=1"]),
  ...(process.env.RIGHTMODELER_LIVE_GITHUB_REPO
    ? []
    : ["RIGHTMODELER_LIVE_GITHUB_REPO"]),
  ...(process.env.GITHUB_TOKEN
    ? []
    : ["GITHUB_TOKEN (a token with the repo and workflow scopes)"]),
];
if (missing.length === 0 && spawnSync("gh", ["--version"]).status !== 0) {
  missing.push("the GitHub CLI (gh) on PATH");
}
if (missing.length > 0) {
  console.warn(`[github live] SKIPPED: set ${missing.join(", ")}`);
}

const execFileAsync = promisify(execFile);
const api = "https://api.github.com";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(packageRoot, "dist-bundle", "cli.js");
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const stubProviderPath = fileURLToPath(
  new URL("../../../fixtures/stub-provider/server.mjs", import.meta.url),
);
const githubStubUrl = new URL(
  "../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
const actionsBot = "github-actions[bot]";
const workflowFile = "rightmodeler-acceptance.yml";
const artifactName = "rightmodeler-acceptance";
const vendorDirectory = join("vendor", "rightmodeler-acceptance");
const tracesFile = join("traces", "summarize-otel.json");

// The Actions job opens the pull request with its GITHUB_TOKEN, a GitHub App installation token
// without the Checks permission. Actions are pinned to the commits of actions/checkout v7.0.1,
// actions/setup-node v7.0.0 and actions/upload-artifact v7.0.1.
const workflow = [
  "name: rightmodeler acceptance",
  "on:",
  "  workflow_dispatch:",
  "permissions: {}",
  "jobs:",
  "  apply:",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 15",
  "    permissions:",
  "      contents: write",
  "      pull-requests: write",
  "      statuses: read",
  "    defaults:",
  "      run:",
  "        working-directory: ${{ github.event.repository.name }}",
  "    env:",
  "      CLI: vendor/rightmodeler-acceptance/cli/cli.js",
  "      GITHUB_TOKEN: ${{ github.token }}",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "        with:",
  "          path: ${{ github.event.repository.name }}",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "        with:",
  "          node-version: 24",
  "          package-manager-cache: false",
  "      - name: Prove the swap against the provider stub",
  "        env:",
  "          RM_STUB_KEY: stub-provider-placeholder",
  "        run: |",
  '          mkdir -p "$RUNNER_TEMP/acceptance"',
  `          nohup node --input-type=module -e 'const { startStubProvider } = await import("./vendor/rightmodeler-acceptance/stub-provider.mjs"); await startStubProvider({ port: 8787 });' >"$RUNNER_TEMP/acceptance/stub-provider.log" 2>&1 &`,
  "          for attempt in $(seq 50); do curl -fsS http://127.0.0.1:8787/v1/models >/dev/null && break; sleep 0.2; done",
  "          code=0",
  `          node "$CLI" init --yes --through report --traces traces/summarize-otel.json --base-url http://127.0.0.1:8787/v1 --api-key-env RM_STUB_KEY --output json >"$RUNNER_TEMP/acceptance/init.json" || code=$?`,
  '          test "$code" -eq 1',
  "      - name: Ask GitHub what this token may read",
  "        run: |",
  '          for probe in "user /user" "check-runs /repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs"; do',
  "            set -- $probe",
  `            curl -sS -o "$RUNNER_TEMP/acceptance/$1.json" -w '%{http_code}' -H "Authorization: Bearer $GITHUB_TOKEN" -H "X-GitHub-Api-Version: 2026-03-10" "https://api.github.com$2" >"$RUNNER_TEMP/acceptance/$1.status"`,
  "          done",
  "      - name: Open the draft pull request",
  `        run: node "$CLI" apply --owner "$GITHUB_REPOSITORY_OWNER" --github-token-env GITHUB_TOKEN --output json >"$RUNNER_TEMP/acceptance/apply.json"`,
  "      - name: Watch the pull request without check runs",
  `        run: node "$CLI" watch --owner "$GITHUB_REPOSITORY_OWNER" --pr "$(jq -r .prNumber "$RUNNER_TEMP/acceptance/apply.json")" --github-token-env GITHUB_TOKEN --output json >"$RUNNER_TEMP/acceptance/watch.json" 2>"$RUNNER_TEMP/acceptance/watch.stderr"`,
  "      - name: Keep the store for the local watch",
  "        if: always()",
  '        run: tar -czf "$RUNNER_TEMP/acceptance/store.tgz" .rightmodeler',
  "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "        if: always()",
  "        with:",
  `          name: ${artifactName}`,
  "          path: ${{ runner.temp }}/acceptance",
  "          retention-days: 7",
  "",
].join("\n");

interface Server {
  readonly port: number;
  close(): Promise<void>;
}

interface GithubStubModule {
  startGithubStub(options: {
    port: number;
    token: string;
    tokenKind: "installation" | "fine-grained";
  }): Promise<Server>;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<Server>;
}

interface Answer {
  readonly status: number;
  readonly body: { message?: string; errors?: string } | null;
  readonly next: string | undefined;
}

interface Login {
  readonly login: string;
}

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function request(
  base: string,
  path: string,
  token: string,
  init: { method?: string; body?: unknown; version?: string } = {},
): Promise<Answer> {
  const response = await fetch(path.startsWith("http") ? path : base + path, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": init.version ?? "2026-03-10",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as Answer["body"]),
    next: /<([^>]+)>;\s*rel="next"/.exec(
      response.headers.get("link") ?? "",
    )?.[1],
  };
}

async function github<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const answer = await request(api, path, token, init);
  if (answer.status >= 300) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${answer.status}: ${JSON.stringify(answer.body)}`,
    );
  }
  return answer.body as T;
}

async function githubList<T>(path: string, token: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = path;
  while (next !== undefined) {
    const answer = await request(api, next, token);
    if (answer.status >= 300) {
      throw new Error(`GET ${next} returned ${answer.status}`);
    }
    items.push(...(answer.body as T[]));
    next = answer.next;
  }
  return items;
}

function run(
  command: string,
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? 10, stdout, stderr }),
    );
  });
}

function runCli(args: readonly string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [cliPath, ...args], envOverrides);
}

function diagnostic(result: CliRun): string {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function jsonLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function pushMain(repo: string, repository: string): Promise<void> {
  // The token reaches git only through the inherited environment, never an argument or a log.
  await execFileAsync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "credential.helper=",
      "-c",
      'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f',
      "push",
      "--force",
      `https://github.com/${repository}.git`,
      "HEAD:main",
    ],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
}

async function dispatchedRun(
  repository: string,
  headSha: string,
  token: string,
): Promise<number> {
  // GitHub may not know a just-pushed workflow yet, so dispatching and finding the run both retry.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dispatched = await run("gh", [
      "workflow",
      "run",
      workflowFile,
      "--repo",
      repository,
      "--ref",
      "main",
    ]);
    if (dispatched.code === 0) break;
    if (attempt === 39) throw new Error(diagnostic(dispatched));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const runs = await github<{ workflow_runs: { id: number }[] }>(
      `/repos/${repository}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&head_sha=${headSha}`,
      token,
    );
    const found = runs.workflow_runs[0];
    if (found !== undefined) return found.id;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`No ${workflowFile} run appeared for ${headSha}`);
}

describe.skipIf(missing.length > 0)("GitHub live acceptance", () => {
  it("opens a draft pull request from GitHub Actions with its installation token, then watches it locally", async () => {
    const repository = process.env.RIGHTMODELER_LIVE_GITHUB_REPO!;
    const token = process.env.GITHUB_TOKEN!;
    const [owner, name] = repository.split("/") as [string, string];

    // 1. The owner reviews, and the repository lets GITHUB_TOKEN open pull requests.
    const reviewer = (await github<Login>("/user", token)).login;
    const workflowPermissions = await github<{
      can_approve_pull_request_reviews: boolean;
    }>(`/repos/${repository}/actions/permissions/workflow`, token);
    expect(
      workflowPermissions.can_approve_pull_request_reviews,
      `enable it with: gh api -X PUT repos/${repository}/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`,
    ).toBe(true);

    // 2. Repository contents: a fresh evidence revision on main for every run, with the built
    // CLI, the provider stub and the workflow that runs them.
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-github-live-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, name);
    await narrowFixtureForApply(repo, join(repo, tracesFile));
    await writeFile(join(repo, "CODEOWNERS"), `* @${reviewer}\n`);
    await writeFile(join(repo, "acceptance-run.txt"), `${randomUUID()}\n`);
    await cp(
      join(packageRoot, "dist-bundle"),
      join(repo, vendorDirectory, "cli"),
      { recursive: true },
    );
    // The bundle is an ES module, as the published package.json declares.
    await writeFile(
      join(repo, vendorDirectory, "cli", "package.json"),
      `${JSON.stringify({ type: "module" })}\n`,
    );
    await cp(
      stubProviderPath,
      join(repo, vendorDirectory, "stub-provider.mjs"),
    );
    await mkdir(join(repo, ".github", "workflows"), { recursive: true });
    await writeFile(join(repo, ".github", "workflows", workflowFile), workflow);
    await commitGitFixture(repo, "Prepare acceptance run");
    await pushMain(repo, repository);
    const pushedSha = (
      await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();

    // 3. Local evidence at $0, then a dry run with the owner's token that writes nothing.
    const provider = await (
      (await import(stubProviderPath)) as StubProviderModule
    ).startStubProvider({ port: 0 });
    try {
      const init = await runCli(
        [
          "init",
          "--yes",
          "--through",
          "report",
          "--traces",
          join(repo, tracesFile),
          "--base-url",
          `http://127.0.0.1:${provider.port}/v1`,
          "--api-key-env",
          "RM_LIVE_STUB_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { RM_LIVE_STUB_KEY: "local-stub-placeholder" },
      );
      expect(init.code, diagnostic(init)).toBe(1);
      expect(JSON.parse(init.stdout)).toMatchObject({
        recommendationExists: true,
      });
    } finally {
      await provider.close();
    }
    const openPulls = async () =>
      (
        await githubList<{ number: number }>(
          `/repos/${repository}/pulls?state=open&per_page=100`,
          token,
        )
      )
        .map(({ number }) => number)
        .sort((left, right) => left - right);
    const branches = async () =>
      (
        await githubList<{ name: string; commit: { sha: string } }>(
          `/repos/${repository}/branches?per_page=100`,
          token,
        )
      )
        .map(({ name: branch, commit }) => `${branch}@${commit.sha}`)
        .sort();
    const pullsBefore = await openPulls();
    const branchesBefore = await branches();
    const dryRun = await runCli([
      "apply",
      "--owner",
      owner,
      "--github-token-env",
      "GITHUB_TOKEN",
      "--dry-run",
      "--output",
      "json",
      "--repo",
      repo,
    ]);
    expect(dryRun.code, diagnostic(dryRun)).toBe(0);
    const planned = JSON.parse(dryRun.stdout) as {
      title: string;
      files: string[];
    };
    expect(planned).toMatchObject({
      status: "dry_run",
      files: expect.arrayContaining(["src/summarize.ts"]),
      reviewers: [reviewer],
    });
    console.info(`[github live] dry run: ${dryRun.stdout.trim()}`);
    expect(await openPulls()).toEqual(pullsBefore);
    expect(await branches()).toEqual(branchesBefore);

    // 4. Apply in GitHub Actions with GITHUB_TOKEN, relying on the base URL and repository
    // defaults, then watch once with that token, which cannot read check runs.
    const runId = await dispatchedRun(repository, pushedSha, token);
    console.info(
      `[github live] workflow run https://github.com/${repository}/actions/runs/${runId}`,
    );
    const watched = await run("gh", [
      "run",
      "watch",
      String(runId),
      "--repo",
      repository,
      "--exit-status",
      "--interval",
      "5",
    ]);
    const outputs = join(root, "actions");
    const downloaded = await run("gh", [
      "run",
      "download",
      String(runId),
      "--repo",
      repository,
      "--name",
      artifactName,
      "--dir",
      outputs,
    ]);
    expect(watched.code, diagnostic(watched)).toBe(0);
    expect(downloaded.code, diagnostic(downloaded)).toBe(0);
    const output = (file: string) => readFile(join(outputs, file), "utf8");
    const applied = JSON.parse(await output("apply.json")) as {
      prNumber: number;
      title: string;
    };
    expect(applied).toMatchObject({
      status: "applied",
      prNumber: expect.any(Number),
      title: planned.title,
      reviewers: [reviewer],
    });
    expect(JSON.parse(await output("watch.json"))).toMatchObject({
      status: "quiet",
    });
    expect(jsonLines(await output("watch.stderr"))).toContainEqual(
      expect.objectContaining({ code: "github_checks_unavailable" }),
    );
    const prNumber = applied.prNumber;
    const pullPath = `/repos/${repository}/pulls/${prNumber}`;
    console.info(
      `[github live] opened https://github.com/${repository}/pull/${prNumber} as ${actionsBot}`,
    );

    // 5. Stub fidelity: the stub answers as GitHub did.
    const stubModule = (await import(githubStubUrl)) as GithubStubModule;
    const stubToken = "github-live-stub-token";
    const installationStub = await stubModule.startGithubStub({
      port: 0,
      token: stubToken,
      tokenKind: "installation",
    });
    const fineGrainedStub = await stubModule.startGithubStub({
      port: 0,
      token: stubToken,
      tokenKind: "fine-grained",
    });
    try {
      for (const stub of [installationStub, fineGrainedStub]) {
        const seeded = await fetch(
          `http://127.0.0.1:${stub.port}/__test/seed`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${stubToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              owner,
              repo: name,
              defaultBranch: "main",
              sha: pushedSha,
            }),
          },
        );
        expect(seeded.status).toBe(201);
      }
      const actionsAnswer = async (probe: string) => ({
        status: Number(await output(`${probe}.status`)),
        body: JSON.parse(await output(`${probe}.json`)) as Answer["body"],
      });
      const pairs = [
        {
          label: "GET /user with GITHUB_TOKEN",
          status: 403,
          real: await actionsAnswer("user"),
          stub: await request(
            `http://127.0.0.1:${installationStub.port}`,
            "/user",
            stubToken,
          ),
        },
        {
          label: "GET check runs with a token that cannot read them",
          status: 403,
          real: await actionsAnswer("check-runs"),
          stub: await request(
            `http://127.0.0.1:${fineGrainedStub.port}`,
            `/repos/${repository}/commits/${pushedSha}/check-runs`,
            stubToken,
          ),
        },
        {
          label: "GET the repository with API version 2099-01-01",
          status: 400,
          real: await request(api, `/repos/${repository}`, token, {
            version: "2099-01-01",
          }),
          stub: await request(
            `http://127.0.0.1:${installationStub.port}`,
            `/repos/${repository}`,
            stubToken,
            { version: "2099-01-01" },
          ),
        },
      ];
      for (const { label, status, real, stub } of pairs) {
        console.info(
          `[github live] ${label}: HTTP ${real.status} ${JSON.stringify(real.body)}`,
        );
        expect(real.status, label).toBe(status);
        expect(stub.status, label).toBe(real.status);
      }
      expect(pairs[2]!.stub.body?.errors).toBe(pairs[2]!.real.body?.errors);
    } finally {
      await Promise.all([installationStub.close(), fineGrainedStub.close()]);
    }

    // 6. What GitHub shows, read as the owner.
    const pull = await github<{
      body: string;
      requested_reviewers: Login[];
    }>(pullPath, token);
    expect(pull).toMatchObject({
      draft: true,
      state: "open",
      merged: false,
      auto_merge: null,
      user: { login: actionsBot },
    });
    expect(pull.requested_reviewers.map(({ login }) => login)).toEqual([
      reviewer,
    ]);
    const files = await githubList<{
      filename: string;
      additions: number;
      deletions: number;
      patch: string;
    }>(`${pullPath}/files?per_page=100`, token);
    expect(files.map(({ filename }) => filename).sort()).toEqual(
      [...planned.files].sort(),
    );
    // Each file changes exactly one line, and only the model identifier on it.
    for (const file of files) {
      expect(file, file.filename).toMatchObject({ additions: 1, deletions: 1 });
      const [removed, added, ...rest] = file.patch
        .split("\n")
        .filter((line) => /^[-+]/.test(line));
      expect(rest, file.filename).toEqual([]);
      const model = /^([-+])(\s+model: ")([^"]+)(",)$/;
      const before = model.exec(removed ?? "");
      const after = model.exec(added ?? "");
      expect(before?.[1], `${file.filename}: ${removed}`).toBe("-");
      expect(after?.[1], `${file.filename}: ${added}`).toBe("+");
      expect(after?.[2]).toBe(before?.[2]);
      expect(after?.[3]).not.toBe(before?.[3]);
    }
    const timeline = await githubList<{
      event: string;
      review_requester?: Login;
      requested_reviewer?: Login;
    }>(`/repos/${repository}/issues/${prNumber}/timeline?per_page=100`, token);
    const reviewRequests = timeline.filter(
      ({ event }) => event === "review_requested",
    );
    expect(reviewRequests.length).toBeGreaterThan(0);
    for (const event of reviewRequests) {
      expect(event.review_requester?.login).toBe(actionsBot);
    }
    expect([
      ...new Set(
        reviewRequests.map((event) => event.requested_reviewer?.login),
      ),
    ]).toEqual([reviewer]);
    expect(timeline.map(({ event }) => event)).not.toContain("merged");
    expect(pull.body).toContain("## Rightmodeler evidence");
    expect(pull.body).toMatch(/`[0-9a-f]{64}`/);
    for (const forbidden of [
      "demo.person@example.test",
      "+1-202-555-0147",
      "The city opened two cooling centers",
    ]) {
      expect(pull.body).not.toContain(forbidden);
    }

    // 7. Watch locally with the owner's token and the store the Actions job wrote.
    await rm(join(repo, ".rightmodeler"), { recursive: true, force: true });
    await execFileAsync("tar", [
      "-xzf",
      join(outputs, "store.tgz"),
      "-C",
      repo,
    ]);
    const watchArgs = [
      "watch",
      "--owner",
      owner,
      "--pr",
      String(prNumber),
      "--github-token-env",
      "GITHUB_TOKEN",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const quiet = await runCli(watchArgs);
    expect(quiet.code, diagnostic(quiet)).toBe(0);
    expect(JSON.parse(quiet.stdout)).toMatchObject({ status: "quiet" });
    expect(quiet.stderr).not.toContain("github_checks_unavailable");

    await github(`/repos/${repository}/issues/${prNumber}/comments`, token, {
      method: "POST",
      body: { body: "Which cases back this swap?" },
    });
    const replied = await runCli(watchArgs);
    expect(replied.code, diagnostic(replied)).toBe(1);
    const repliedResult = JSON.parse(replied.stdout) as {
      actions: { type: string }[];
    };
    expect(
      repliedResult.actions.filter(({ type }) => type === "evidence_replied"),
    ).toHaveLength(1);
    const comments = await githubList<{ user: Login; body: string }>(
      `/repos/${repository}/issues/${prNumber}/comments?per_page=100`,
      token,
    );
    expect(
      comments.filter(({ body }) => body.includes("<!-- rightmodeler-watch:")),
    ).toHaveLength(1);

    const answered = await runCli(watchArgs);
    expect(answered.code, diagnostic(answered)).toBe(0);
    expect(JSON.parse(answered.stdout)).toMatchObject({ status: "quiet" });

    // 8. Nothing merged.
    await expect(github(pullPath, token)).resolves.toMatchObject({
      draft: true,
      state: "open",
      merged: false,
      auto_merge: null,
    });
  }, 900_000);
});
