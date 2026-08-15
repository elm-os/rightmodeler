import { afterEach, describe, expect, it } from "vitest";

import {
  BlockedError,
  createGithubClient,
  GithubContentRefusalError,
  GithubHttpError,
  GithubRequestError,
  type GithubClient,
} from "./client.js";

const stubModuleUrl = new URL(
  "../../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
const tokenEnv = "RIGHTMODELER_GITHUB_TEST_TOKEN";
const token = "github-client-canary-must-never-persist";

interface StubHit {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorized: boolean;
}

interface StubServer {
  readonly port: number;
  getHits(): readonly StubHit[];
  close(): Promise<void>;
}

interface StubModule {
  startGithubStub(options: {
    port: number;
    token?: string;
    rateLimit?: {
      remainingResponses: number;
      status?: 403 | 429;
      retryAfter?: string | number;
      resetAt?: number;
    };
    reflectAuthError?: boolean;
    malformedResponsePath?: string;
    paginationPageSize?: number;
    foreignPaginationLink?: boolean;
    contentDirectoryResponse?: boolean;
    contentEncodingNoneResponse?: boolean;
  }): Promise<StubServer>;
}

const openStubs: StubServer[] = [];

afterEach(async () => {
  delete process.env[tokenEnv];
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
});

async function startStub(
  options: Omit<Parameters<StubModule["startGithubStub"]>[0], "port"> = {},
): Promise<StubServer> {
  const module = (await import(stubModuleUrl)) as StubModule;
  const stub = await module.startGithubStub({ port: 0, token, ...options });
  openStubs.push(stub);
  return stub;
}

function baseUrl(stub: StubServer): string {
  return `http://127.0.0.1:${stub.port}`;
}

function client(stub: StubServer): GithubClient {
  return createGithubClient({ baseUrl: baseUrl(stub), tokenEnv });
}

async function control<T>(
  stub: StubServer,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl(stub)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`Test control ${path} failed with ${response.status}`);
  return (await response.json()) as T;
}

interface SeededRepo {
  readonly sha: string;
}

async function seed(stub: StubServer): Promise<SeededRepo> {
  return control(stub, "/__test/seed", {
    owner: "acme",
    repo: "demo",
    defaultBranch: "main",
    tree: {
      README: "hello\n",
      src: { "existing.ts": "export const existing = true;\n" },
    },
  });
}

const repository = { owner: "acme", repo: "demo" } as const;

describe("GitHub client conformance", () => {
  it("drives every supported operation against the in-memory API", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub();
    const seeded = await seed(stub);
    const github = client(stub);

    await expect(
      github.getRef({ ...repository, ref: "heads/main" }),
    ).resolves.toEqual({
      ref: "refs/heads/main",
      sha: seeded.sha,
    });

    await expect(
      github.createRef({
        ...repository,
        ref: "refs/heads/rightmodeler/change",
        sha: seeded.sha,
      }),
    ).resolves.toEqual({
      ref: "refs/heads/rightmodeler/change",
      sha: seeded.sha,
    });

    await expect(
      github.getFileContent({
        ...repository,
        path: "src/existing.ts",
        ref: seeded.sha,
      }),
    ).resolves.toEqual({
      path: "src/existing.ts",
      sha: expect.stringMatching(/^[a-f0-9]{40}$/),
      content: "export const existing = true;\n",
      contentBytes: Buffer.from("export const existing = true;\n"),
    });
    await expect(
      github.findOpenPullRequest({
        ...repository,
        head: "rightmodeler/change",
        base: "main",
      }),
    ).resolves.toBeNull();

    const created = await github.createOrUpdateFile({
      ...repository,
      path: "src/new file.ts",
      message: "Create model swap",
      content: "export const model = 'small';\n",
      branch: "rightmodeler/change",
    });
    expect(created.content).toMatchObject({ path: "src/new file.ts" });
    expect(created.commit.message).toBe("Create model swap");

    const updated = await github.createOrUpdateFile({
      ...repository,
      path: "src/new file.ts",
      message: "Update model swap",
      content: "export const model = 'smaller';\n",
      branch: "rightmodeler/change",
      sha: created.content?.sha,
    });
    expect(updated.content?.sha).not.toBe(created.content?.sha);
    await expect(
      github.getFileContent({
        ...repository,
        path: "src/new file.ts",
        ref: "rightmodeler/change",
      }),
    ).resolves.toMatchObject({
      path: "src/new file.ts",
      sha: updated.content?.sha,
      content: "export const model = 'smaller';\n",
    });

    await expect(
      github.compareCommits({
        ...repository,
        base: "main",
        head: "rightmodeler/change",
      }),
    ).resolves.toMatchObject({
      status: "ahead",
      aheadBy: 2,
      behindBy: 0,
      totalCommits: 2,
      baseCommitSha: seeded.sha,
      mergeBaseCommitSha: seeded.sha,
      files: [{ filename: "src/new file.ts", status: "added" }],
    });

    const pull = await github.createPullRequest({
      ...repository,
      title: "Use the smaller model",
      body: "Evidence is attached.",
      head: "rightmodeler/change",
      base: "main",
      draft: true,
    });
    expect(pull).toMatchObject({
      number: 1,
      state: "open",
      draft: true,
      merged: false,
      requestedReviewers: [],
    });
    await expect(
      github.findOpenPullRequest({
        ...repository,
        head: "rightmodeler/change",
        base: "main",
      }),
    ).resolves.toMatchObject({ number: pull.number });

    const requested = await github.requestReviewers({
      ...repository,
      pullNumber: pull.number,
      reviewers: ["owner"],
      teamReviewers: ["platform"],
    });
    expect(requested.requestedReviewers).toEqual(["owner"]);
    expect(requested.requestedTeams).toEqual(["platform"]);

    await control(stub, "/__test/reviews", {
      ...repository,
      pullNumber: pull.number,
      user: "owner",
      state: "CHANGES_REQUESTED",
      body: "Please explain this line.",
      comments: [{ body: "Why this model?", path: "src/new file.ts", line: 1 }],
    });
    await expect(
      github.listReviews({ ...repository, pullNumber: pull.number }),
    ).resolves.toEqual([
      expect.objectContaining({
        user: "owner",
        state: "CHANGES_REQUESTED",
        body: "Please explain this line.",
      }),
    ]);
    await expect(
      github.listReviewComments({ ...repository, pullNumber: pull.number }),
    ).resolves.toEqual([
      expect.objectContaining({
        user: "owner",
        body: "Why this model?",
        path: "src/new file.ts",
        line: 1,
      }),
    ]);

    const issueComment = await github.createIssueComment({
      ...repository,
      issueNumber: pull.number,
      body: "Re-proved against the requested change.",
    });
    expect(issueComment).toMatchObject({
      user: "rightmodeler-bot",
      body: "Re-proved against the requested change.",
    });
    await expect(
      github.listIssueComments({ ...repository, issueNumber: pull.number }),
    ).resolves.toEqual([issueComment]);

    await control(stub, "/__test/check-runs", {
      ...repository,
      ref: "rightmodeler/change",
      runs: [
        { name: "test", conclusion: "success" },
        { name: "lint", conclusion: null, status: "in_progress" },
      ],
    });
    await expect(
      github.listCheckRunsForRef({ ...repository, ref: "rightmodeler/change" }),
    ).resolves.toMatchObject({
      totalCount: 2,
      checkRuns: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "lint", status: "in_progress", conclusion: null },
      ],
    });

    const beforeAdvance = await github.getPullRequest({
      ...repository,
      pullNumber: pull.number,
    });
    const advanced = await control<{ object: { sha: string } }>(
      stub,
      "/__test/advance-base",
      {
        ...repository,
        tree: { "base-change.txt": "base moved\n" },
      },
    );
    const afterAdvance = await github.getPullRequest({
      ...repository,
      pullNumber: pull.number,
    });
    expect(afterAdvance.base.sha).toBe(beforeAdvance.base.sha);
    expect(afterAdvance.base.sha).not.toBe(advanced.object.sha);
    await expect(
      github.getRef({ ...repository, ref: "heads/main" }),
    ).resolves.toMatchObject({ sha: advanced.object.sha });
    await expect(
      github.compareCommits({
        ...repository,
        base: "main",
        head: "rightmodeler/change",
      }),
    ).resolves.toMatchObject({ status: "diverged", aheadBy: 2, behindBy: 1 });

    await expect(
      github.closePullRequest({ ...repository, pullNumber: pull.number }),
    ).resolves.toMatchObject({ state: "closed", merged: false });
    await control(stub, "/__test/merge", {
      ...repository,
      pullNumber: pull.number,
    });
    await expect(
      github.getPullRequest({ ...repository, pullNumber: pull.number }),
    ).resolves.toMatchObject({ state: "closed", merged: true });

    const paths = stub.getHits().map(({ method, path }) => `${method} ${path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "GET /repos/acme/demo/git/ref/heads/main",
        "POST /repos/acme/demo/git/refs",
        "GET /repos/acme/demo/contents/src/existing.ts",
        "PUT /repos/acme/demo/contents/src/new%20file.ts",
        "GET /repos/acme/demo/contents/src/new%20file.ts",
        "GET /repos/acme/demo/compare/main...rightmodeler/change",
        "GET /repos/acme/demo/pulls",
        "POST /repos/acme/demo/pulls",
        "POST /repos/acme/demo/pulls/1/requested_reviewers",
        "GET /repos/acme/demo/pulls/1/reviews",
        "GET /repos/acme/demo/pulls/1/comments",
        "GET /repos/acme/demo/issues/1/comments",
        "POST /repos/acme/demo/issues/1/comments",
        "GET /repos/acme/demo/pulls/1",
        "GET /repos/acme/demo/commits/rightmodeler/change/check-runs",
        "PATCH /repos/acme/demo/pulls/1",
      ]),
    );
  });

  it("exposes only the allowed pull-request lifecycle surface", async () => {
    const stub = await startStub();
    const methods = Object.keys(client(stub)).sort();

    expect(methods).toEqual([
      "closePullRequest",
      "compareCommits",
      "createIssueComment",
      "createOrUpdateFile",
      "createPullRequest",
      "createRef",
      "findOpenPullRequest",
      "getFileContent",
      "getPullRequest",
      "getRef",
      "listCheckRunsForRef",
      "listIssueComments",
      "listReviewComments",
      "listReviews",
      "requestReviewers",
    ]);
    expect(Object.keys(await import("./client.js")).sort()).toEqual([
      "BlockedError",
      "GithubContentRefusalError",
      "GithubHttpError",
      "GithubRequestError",
      "createGithubClient",
    ]);
  });

  it("paginates reviews, comments, and check runs while preserving event authors and states", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub({ paginationPageSize: 1 });
    const seeded = await seed(stub);
    const github = client(stub);
    await github.createRef({
      ...repository,
      ref: "refs/heads/rightmodeler/paginated",
      sha: seeded.sha,
    });
    const pull = await github.createPullRequest({
      ...repository,
      title: "Paginated lifecycle",
      body: "Evidence",
      head: "rightmodeler/paginated",
      base: "main",
      draft: true,
    });

    await control(stub, "/__test/reviews", {
      ...repository,
      pullNumber: pull.number,
      user: "owner-one",
      state: "COMMENTED",
      comments: [{ body: "First", path: "README", line: 1 }],
    });
    await control(stub, "/__test/reviews", {
      ...repository,
      pullNumber: pull.number,
      user: "owner-two",
      state: "DISMISSED",
      comments: [{ body: "Second", path: "README", line: 1 }],
    });
    await control(stub, "/__test/issue-comments", {
      ...repository,
      pullNumber: pull.number,
      author: "mentioner-one",
      body: "@rightmodeler first",
    });
    await control(stub, "/__test/issue-comments", {
      ...repository,
      pullNumber: pull.number,
      author: "mentioner-two",
      body: "@rightmodeler second",
    });
    await control(stub, "/__test/check-runs", {
      ...repository,
      ref: "rightmodeler/paginated",
      runs: [
        { name: "first", conclusion: "success" },
        { name: "second", conclusion: "failure" },
      ],
    });

    await expect(
      github.listReviews({ ...repository, pullNumber: pull.number }),
    ).resolves.toMatchObject([
      { user: "owner-one", state: "COMMENTED" },
      { user: "owner-two", state: "DISMISSED" },
    ]);
    await expect(
      github.listReviewComments({ ...repository, pullNumber: pull.number }),
    ).resolves.toMatchObject([{ body: "First" }, { body: "Second" }]);
    await expect(
      github.listIssueComments({ ...repository, issueNumber: pull.number }),
    ).resolves.toMatchObject([
      { user: "mentioner-one", body: "@rightmodeler first" },
      { user: "mentioner-two", body: "@rightmodeler second" },
    ]);
    await expect(
      github.listCheckRunsForRef({
        ...repository,
        ref: "rightmodeler/paginated",
      }),
    ).resolves.toMatchObject({
      totalCount: 2,
      checkRuns: [{ name: "first" }, { name: "second" }],
    });

    const paths = stub.getHits().map(({ path }) => path);
    expect(
      paths.filter((path) => path === "/repos/acme/demo/pulls/1/reviews"),
    ).toHaveLength(2);
    expect(
      paths.filter(
        (path) =>
          path === "/repos/acme/demo/commits/rightmodeler/paginated/check-runs",
      ),
    ).toHaveLength(2);
  });

  it("rejects a pagination link that leaves the configured API origin", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub({
      paginationPageSize: 1,
      foreignPaginationLink: true,
    });
    const seeded = await seed(stub);
    const github = client(stub);
    await github.createRef({
      ...repository,
      ref: "refs/heads/rightmodeler/foreign-page",
      sha: seeded.sha,
    });
    const pull = await github.createPullRequest({
      ...repository,
      title: "Foreign page",
      body: "Evidence",
      head: "rightmodeler/foreign-page",
      base: "main",
      draft: true,
    });
    for (const user of ["owner-one", "owner-two"]) {
      await control(stub, "/__test/reviews", {
        ...repository,
        pullNumber: pull.number,
        user,
        state: "COMMENTED",
      });
    }

    await expect(
      github.listReviews({ ...repository, pullNumber: pull.number }),
    ).rejects.toThrow("GitHub pagination attempted to leave the API host");
  });
});

describe("GitHub client rate limits and credential hygiene", () => {
  it("honors Retry-After before retrying a rate-limited request", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub({
      rateLimit: { remainingResponses: 1, status: 429, retryAfter: 0.05 },
    });
    const seeded = await seed(stub);

    const startedAt = performance.now();
    await expect(
      client(stub).getRef({ ...repository, ref: "heads/main" }),
    ).resolves.toEqual({
      ref: "refs/heads/main",
      sha: seeded.sha,
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(
      stub
        .getHits()
        .filter(({ path }) => path === "/repos/acme/demo/git/ref/heads/main"),
    ).toHaveLength(2);
  });

  it("uses reset-based backoff and surfaces typed exhaustion after five attempts", async () => {
    process.env[tokenEnv] = token;
    const resetAt = Math.floor(Date.now() / 1_000);
    const stub = await startStub({
      rateLimit: { remainingResponses: 5, status: 403, resetAt },
    });
    await seed(stub);

    let failure: unknown;
    try {
      await client(stub).getRef({ ...repository, ref: "heads/main" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BlockedError);
    expect(failure).toMatchObject({
      kind: "github-rate-limit",
      resetAt: new Date(resetAt * 1_000).toISOString(),
    });
    expect(
      stub
        .getHits()
        .filter(({ path }) => path === "/repos/acme/demo/git/ref/heads/main"),
    ).toHaveLength(5);
  });

  it("surfaces a long server-requested delay instead of sleeping past the bound", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub({
      rateLimit: { remainingResponses: 1, status: 429, retryAfter: 61 },
    });
    await seed(stub);

    await expect(
      client(stub).getRef({ ...repository, ref: "heads/main" }),
    ).rejects.toMatchObject({ kind: "github-rate-limit" });
    expect(
      stub
        .getHits()
        .filter(({ path }) => path === "/repos/acme/demo/git/ref/heads/main"),
    ).toHaveLength(1);
  });

  it("reads the environment token at call time and sends it only as outbound auth", async () => {
    const stub = await startStub();
    await seed(stub);
    const github = client(stub);

    process.env[tokenEnv] = token;
    await github.getRef({ ...repository, ref: "heads/main" });
    process.env[tokenEnv] = "rotated-wrong-token";
    await expect(
      github.getRef({ ...repository, ref: "heads/main" }),
    ).rejects.toBeInstanceOf(GithubHttpError);

    const requestHits = stub
      .getHits()
      .filter(({ path }) => path === "/repos/acme/demo/git/ref/heads/main");
    expect(requestHits.map(({ authorized }) => authorized)).toEqual([
      true,
      false,
    ]);
    expect(JSON.stringify(stub.getHits())).not.toContain(token);
    expect(JSON.stringify(stub.getHits())).not.toContain("rotated-wrong-token");
  });

  it("redacts a reflected token from errors and never returns or records it", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub({ reflectAuthError: true });
    await seed(stub);
    const github = client(stub);

    let failure: Error | undefined;
    try {
      await github.getRef({ ...repository, ref: "heads/main" });
    } catch (error) {
      if (error instanceof Error) failure = error;
    }

    expect(failure?.message).toContain("[redacted]");
    const serialized = JSON.stringify({
      failure:
        failure === undefined
          ? null
          : { name: failure.name, message: failure.message },
      hits: stub.getHits(),
    });
    expect(serialized).not.toContain(token);
  });

  it("fails loudly when a successful response violates the endpoint contract", async () => {
    process.env[tokenEnv] = token;
    const stub = await startStub({
      malformedResponsePath: "/repos/acme/demo/git/ref/heads/main",
    });
    await seed(stub);

    await expect(
      client(stub).getRef({ ...repository, ref: "heads/main" }),
    ).rejects.toBeInstanceOf(GithubRequestError);
  });

  it.each([
    {
      name: "directory array",
      options: { contentDirectoryResponse: true },
      code: "github_path_is_directory",
    },
    {
      name: "non-inline file",
      options: { contentEncodingNoneResponse: true },
      code: "github_file_content_unavailable",
    },
  ] as const)("names a $name contents response", async ({ options, code }) => {
    process.env[tokenEnv] = token;
    const stub = await startStub(options);
    const seeded = await seed(stub);

    await expect(
      client(stub).getFileContent({
        ...repository,
        path: "src/existing.ts",
        ref: seeded.sha,
      }),
    ).rejects.toMatchObject({
      name: "GithubContentRefusalError",
      code,
    } satisfies Partial<GithubContentRefusalError>);
  });

  it("does not read or retain the token while the client is created", async () => {
    const stub = await startStub();
    const github = client(stub);

    await expect(
      github.getRef({ ...repository, ref: "heads/main" }),
    ).rejects.toBeInstanceOf(GithubRequestError);
    expect(stub.getHits()).toEqual([]);
  });
});
