import { z } from "zod";

export interface GithubRepository {
  readonly owner: string;
  readonly repo: string;
}

export interface GithubRef {
  readonly ref: string;
  readonly sha: string;
}

export interface GithubFileCommit {
  readonly content: { readonly path: string; readonly sha: string } | null;
  readonly commit: { readonly sha: string; readonly message: string };
}

export interface GithubPullRequest {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly requestedReviewers: readonly string[];
  readonly requestedTeams: readonly string[];
}

export type GithubReviewState =
  "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface GithubReview {
  readonly id: number;
  readonly user: string;
  readonly body: string;
  readonly state: GithubReviewState;
  readonly submittedAt: string | null;
  readonly commitId: string;
}

export interface GithubReviewComment {
  readonly id: number;
  readonly reviewId: number | null;
  readonly user: string;
  readonly body: string;
  readonly path: string;
  readonly line: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GithubIssueComment {
  readonly id: number;
  readonly user: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GithubCheckRun {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status:
    | "queued"
    | "in_progress"
    | "completed"
    | "waiting"
    | "requested"
    | "pending";
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface GithubCheckRuns {
  readonly totalCount: number;
  readonly checkRuns: readonly GithubCheckRun[];
}

export interface GithubComparison {
  readonly status: "ahead" | "behind" | "diverged" | "identical";
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly totalCommits: number;
  readonly baseCommitSha: string;
  readonly mergeBaseCommitSha: string;
  readonly files: readonly {
    readonly filename: string;
    readonly status: string;
    readonly sha: string;
  }[];
}

export interface GithubClient {
  getRef(
    input: GithubRepository & { readonly ref: string },
  ): Promise<GithubRef>;
  compareCommits(
    input: GithubRepository & {
      readonly base: string;
      readonly head: string;
    },
  ): Promise<GithubComparison>;
  createRef(
    input: GithubRepository & { readonly ref: string; readonly sha: string },
  ): Promise<GithubRef>;
  createOrUpdateFile(
    input: GithubRepository & {
      readonly path: string;
      readonly message: string;
      readonly content: string;
      readonly branch: string;
      readonly sha?: string;
    },
  ): Promise<GithubFileCommit>;
  createPullRequest(
    input: GithubRepository & {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
      readonly draft: boolean;
    },
  ): Promise<GithubPullRequest>;
  requestReviewers(
    input: GithubRepository & {
      readonly pullNumber: number;
      readonly reviewers: readonly string[];
      readonly teamReviewers?: readonly string[];
    },
  ): Promise<GithubPullRequest>;
  listReviews(
    input: GithubRepository & { readonly pullNumber: number },
  ): Promise<readonly GithubReview[]>;
  listReviewComments(
    input: GithubRepository & { readonly pullNumber: number },
  ): Promise<readonly GithubReviewComment[]>;
  listIssueComments(
    input: GithubRepository & { readonly issueNumber: number },
  ): Promise<readonly GithubIssueComment[]>;
  createIssueComment(
    input: GithubRepository & {
      readonly issueNumber: number;
      readonly body: string;
    },
  ): Promise<GithubIssueComment>;
  getPullRequest(
    input: GithubRepository & { readonly pullNumber: number },
  ): Promise<GithubPullRequest>;
  listCheckRunsForRef(
    input: GithubRepository & { readonly ref: string },
  ): Promise<GithubCheckRuns>;
  closePullRequest(
    input: GithubRepository & { readonly pullNumber: number },
  ): Promise<GithubPullRequest>;
}

export interface CreateGithubClientOptions {
  readonly baseUrl: string;
  readonly tokenEnv: string;
}

export class BlockedError extends Error {
  readonly kind = "github-rate-limit" as const;
  readonly resetAt: string;

  constructor(resetAt: string) {
    super(`GitHub rate limit retries exhausted; reset at ${resetAt}`);
    this.name = "BlockedError";
    this.resetAt = resetAt;
  }
}

export class GithubRequestError extends Error {}

export class GithubHttpError extends GithubRequestError {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`GitHub request failed with HTTP ${status}: ${body}`);
    this.name = "GithubHttpError";
    this.status = status;
  }
}

const userSchema = z.object({ login: z.string() });
const teamSchema = z.object({ slug: z.string() });
const refSchema = z.object({
  ref: z.string(),
  object: z.object({ sha: z.string() }),
});
const fileCommitSchema = z.object({
  content: z.object({ path: z.string(), sha: z.string() }).nullable(),
  commit: z.object({ sha: z.string(), message: z.string() }),
});
const pullRequestSchema = z.object({
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  body: z.string().nullable(),
  draft: z.boolean(),
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
  requested_reviewers: z.array(userSchema).default([]),
  requested_teams: z.array(teamSchema).default([]),
});
const reviewSchema = z.object({
  id: z.number().int(),
  user: userSchema,
  body: z.string().nullable(),
  state: z.enum([
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
    "PENDING",
  ]),
  submitted_at: z.string().nullable(),
  commit_id: z.string(),
});
const reviewCommentSchema = z.object({
  id: z.number().int(),
  pull_request_review_id: z.number().int().nullable(),
  user: userSchema,
  body: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const issueCommentSchema = z.object({
  id: z.number().int(),
  user: userSchema,
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
const checkRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  head_sha: z.string(),
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
const checkRunsSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(checkRunSchema),
});
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  ahead_by: z.number().int(),
  behind_by: z.number().int(),
  total_commits: z.number().int(),
  base_commit: z.object({ sha: z.string() }),
  merge_base_commit: z.object({ sha: z.string() }),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        sha: z.string(),
      }),
    )
    .default([]),
});

const maxAttempts = 5;
const maxRetryDelayMs = 60_000;

function redact(value: string, token: string): string {
  return value.replaceAll(token, "[redacted]");
}

function pathPart(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function repositoryPath(input: GithubRepository): string {
  return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
}

function retryAfterAt(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? now + seconds * 1_000
    : undefined;
}

function rateResetAt(
  response: Response,
  now: number,
  retryAfter: number | undefined,
): number {
  const rawReset = response.headers.get("x-ratelimit-reset");
  if (rawReset !== null) {
    const seconds = Number(rawReset);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  }
  return retryAfter ?? now + maxRetryDelayMs;
}

function rateLimitTiming(response: Response): {
  readonly resetAt: number;
  readonly delay: number;
} {
  const now = Date.now();
  const retryAfter = retryAfterAt(response, now);
  const resetAt = rateResetAt(response, now, retryAfter);
  return {
    resetAt,
    delay: Math.max(0, (retryAfter ?? resetAt) - now),
  };
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GithubRequestError(`${label} was not valid JSON`);
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new GithubRequestError(
      `${label} did not match the GitHub response schema`,
    );
  }
  return result.data;
}

function normalizePullRequest(
  raw: z.infer<typeof pullRequestSchema>,
): GithubPullRequest {
  return {
    number: raw.number,
    state: raw.state,
    title: raw.title,
    body: raw.body,
    draft: raw.draft,
    merged: raw.merged,
    mergedAt: raw.merged_at,
    closedAt: raw.closed_at,
    head: raw.head,
    base: raw.base,
    requestedReviewers: raw.requested_reviewers.map(({ login }) => login),
    requestedTeams: raw.requested_teams.map(({ slug }) => slug),
  };
}

interface GithubResponse {
  readonly response: Response;
  readonly text: string;
}

export function createGithubClient(
  options: CreateGithubClientOptions,
): GithubClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const apiOrigin = new URL(baseUrl).origin;

  function token(): string {
    const value = process.env[options.tokenEnv];
    if (value === undefined || value.length === 0) {
      throw new GithubRequestError(
        `GitHub token environment variable is not set: ${options.tokenEnv}`,
      );
    }
    return value;
  }

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<GithubResponse> {
    let lastResetAt = Date.now() + maxRetryDelayMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requestToken = token();
      const headers = new Headers(init.headers);
      headers.set("accept", "application/vnd.github+json");
      headers.set("authorization", `Bearer ${requestToken}`);
      headers.set("x-github-api-version", "2026-03-10");
      if (init.body !== undefined)
        headers.set("content-type", "application/json");

      let response: Response;
      try {
        response = await fetch(
          path.startsWith("http") ? path : `${baseUrl}${path}`,
          {
            ...init,
            headers,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GithubRequestError(redact(message, requestToken));
      }

      if (response.ok) return { response, text: await response.text() };
      if (isRateLimited(response)) {
        const timing = rateLimitTiming(response);
        lastResetAt = timing.resetAt;
        await response.body?.cancel();
        if (attempt === maxAttempts || timing.delay > maxRetryDelayMs) {
          throw new BlockedError(new Date(lastResetAt).toISOString());
        }
        await sleep(timing.delay);
        continue;
      }

      const body = redact(await response.text(), requestToken).slice(0, 500);
      throw new GithubHttpError(response.status, body);
    }
    throw new BlockedError(new Date(lastResetAt).toISOString());
  }

  async function requestJson<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T> {
    const result = await request(path, init);
    return parsed(schema, parseJson(result.text, label), label);
  }

  async function listJson<T>(
    path: string,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined =
      `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next !== undefined) {
      const result = await request(next);
      items.push(
        ...parsed(z.array(schema), parseJson(result.text, label), label),
      );
      next = nextPage(result.response);
    }
    return items;
  }

  function nextPage(response: Response): string | undefined {
    const link = response.headers.get("link");
    const match = link?.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1] === undefined) return undefined;
    const candidate = new URL(match[1], baseUrl);
    if (candidate.origin !== apiOrigin) {
      throw new GithubRequestError(
        "GitHub pagination attempted to leave the API host",
      );
    }
    return candidate.toString();
  }

  return {
    async getRef(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/git/ref/${pathPart(input.ref)}`,
        {},
        refSchema,
        "GitHub reference response",
      );
      return { ref: raw.ref, sha: raw.object.sha };
    },

    async compareCommits(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/compare/${pathPart(input.base)}...${pathPart(input.head)}`,
        {},
        comparisonSchema,
        "GitHub comparison response",
      );
      return {
        status: raw.status,
        aheadBy: raw.ahead_by,
        behindBy: raw.behind_by,
        totalCommits: raw.total_commits,
        baseCommitSha: raw.base_commit.sha,
        mergeBaseCommitSha: raw.merge_base_commit.sha,
        files: raw.files,
      };
    },

    async createRef(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/git/refs`,
        {
          method: "POST",
          body: JSON.stringify({ ref: input.ref, sha: input.sha }),
        },
        refSchema,
        "GitHub create-reference response",
      );
      return { ref: raw.ref, sha: raw.object.sha };
    },

    async createOrUpdateFile(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/contents/${pathPart(input.path)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message: input.message,
            content: Buffer.from(input.content, "utf8").toString("base64"),
            branch: input.branch,
            ...(input.sha === undefined ? {} : { sha: input.sha }),
          }),
        },
        fileCommitSchema,
        "GitHub file-contents response",
      );
      return raw;
    },

    async createPullRequest(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
            draft: input.draft,
          }),
        },
        pullRequestSchema,
        "GitHub create-pull-request response",
      );
      return normalizePullRequest(raw);
    },

    async requestReviewers(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/pulls/${input.pullNumber}/requested_reviewers`,
        {
          method: "POST",
          body: JSON.stringify({
            reviewers: input.reviewers,
            ...(input.teamReviewers === undefined
              ? {}
              : { team_reviewers: input.teamReviewers }),
          }),
        },
        pullRequestSchema,
        "GitHub request-reviewers response",
      );
      return normalizePullRequest(raw);
    },

    async listReviews(input) {
      const raw = await listJson(
        `${repositoryPath(input)}/pulls/${input.pullNumber}/reviews`,
        reviewSchema,
        "GitHub reviews response",
      );
      return raw.map((review) => ({
        id: review.id,
        user: review.user.login,
        body: review.body ?? "",
        state: review.state,
        submittedAt: review.submitted_at,
        commitId: review.commit_id,
      }));
    },

    async listReviewComments(input) {
      const raw = await listJson(
        `${repositoryPath(input)}/pulls/${input.pullNumber}/comments`,
        reviewCommentSchema,
        "GitHub review-comments response",
      );
      return raw.map((comment) => ({
        id: comment.id,
        reviewId: comment.pull_request_review_id,
        user: comment.user.login,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      }));
    },

    async listIssueComments(input) {
      const raw = await listJson(
        `${repositoryPath(input)}/issues/${input.issueNumber}/comments`,
        issueCommentSchema,
        "GitHub issue-comments response",
      );
      return raw.map((comment) => ({
        id: comment.id,
        user: comment.user.login,
        body: comment.body,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      }));
    },

    async createIssueComment(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/issues/${input.issueNumber}/comments`,
        { method: "POST", body: JSON.stringify({ body: input.body }) },
        issueCommentSchema,
        "GitHub create-issue-comment response",
      );
      return {
        id: raw.id,
        user: raw.user.login,
        body: raw.body,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      };
    },

    async getPullRequest(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/pulls/${input.pullNumber}`,
        {},
        pullRequestSchema,
        "GitHub pull-request response",
      );
      return normalizePullRequest(raw);
    },

    async listCheckRunsForRef(input) {
      const runs: z.infer<typeof checkRunSchema>[] = [];
      let totalCount = 0;
      let next: string | undefined =
        `${repositoryPath(input)}/commits/${pathPart(input.ref)}/check-runs?per_page=100`;
      while (next !== undefined) {
        const result = await request(next);
        const raw = parsed(
          checkRunsSchema,
          parseJson(result.text, "GitHub check-runs response"),
          "GitHub check-runs response",
        );
        totalCount = raw.total_count;
        runs.push(...raw.check_runs);
        next = nextPage(result.response);
      }
      return {
        totalCount,
        checkRuns: runs.map((run) => ({
          id: run.id,
          name: run.name,
          headSha: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
          startedAt: run.started_at,
          completedAt: run.completed_at,
        })),
      };
    },

    async closePullRequest(input) {
      const raw = await requestJson(
        `${repositoryPath(input)}/pulls/${input.pullNumber}`,
        { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
        pullRequestSchema,
        "GitHub close-pull-request response",
      );
      return normalizePullRequest(raw);
    },
  };
}
