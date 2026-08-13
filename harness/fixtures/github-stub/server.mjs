import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function blobSha(content) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");
}

function flattenTree(tree, prefix = "", files = new Map()) {
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    throw new Error("tree must be a JSON object");
  }
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    if (typeof value === "string") {
      files.set(path, { content: value, sha: blobSha(value) });
    } else {
      flattenTree(value, path, files);
    }
  }
  return files;
}

function cloneFiles(files) {
  return new Map([...files].map(([path, file]) => [path, { ...file }]));
}

function user(login) {
  return { login };
}

export async function startGithubStub({
  port,
  token = "github-stub-token",
  rateLimit,
  reflectAuthError = false,
  malformedResponsePath,
}) {
  const repositories = new Map();
  const hits = [];
  let nextCommit = 1;
  let nextReview = 1;
  let nextComment = 1;
  let nextCheckRun = 1;
  let clockTick = 0;
  let reflected = false;
  const rate = rateLimit === undefined ? undefined : { ...rateLimit };

  function now() {
    const value = new Date(
      Date.UTC(2026, 0, 1) + clockTick * 1_000,
    ).toISOString();
    clockTick += 1;
    return value;
  }

  function repoKey(owner, repo) {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  function repository(owner, repo) {
    return repositories.get(repoKey(owner, repo));
  }

  function commit(repo, parent, files, message) {
    const sha = createHash("sha1")
      .update(
        JSON.stringify({
          repository: repo.key,
          sequence: nextCommit,
          parent,
          message,
          files: [...files].map(([path, file]) => [path, file.sha]),
        }),
      )
      .digest("hex");
    nextCommit += 1;
    repo.commits.set(sha, { sha, parent, files: cloneFiles(files), message });
    return sha;
  }

  function fullRef(ref) {
    if (ref.startsWith("refs/")) return ref;
    if (ref.startsWith("heads/") || ref.startsWith("tags/"))
      return `refs/${ref}`;
    return `refs/heads/${ref}`;
  }

  function resolveCommit(repo, value) {
    const fromRef = repo.refs.get(fullRef(value));
    const sha = fromRef ?? value;
    return repo.commits.has(sha) ? sha : undefined;
  }

  function refResponse(ref, sha) {
    return { ref, object: { type: "commit", sha } };
  }

  function pullResponse(repo, pull) {
    return {
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      draft: pull.draft,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      closed_at: pull.closedAt,
      head: {
        ref: pull.head,
        sha: repo.refs.get(fullRef(pull.head)) ?? pull.headSha,
      },
      base: {
        ref: pull.base,
        sha: repo.refs.get(fullRef(pull.base)) ?? pull.baseSha,
      },
      requested_reviewers: pull.reviewers.map(user),
      requested_teams: pull.teamReviewers.map((name) => ({ name })),
    };
  }

  function getPull(repo, number) {
    return repo.pulls.get(number);
  }

  function ancestry(repo, start) {
    const distances = new Map();
    let sha = start;
    let distance = 0;
    while (sha !== null && !distances.has(sha)) {
      distances.set(sha, distance);
      const current = repo.commits.get(sha);
      sha = current?.parent ?? null;
      distance += 1;
    }
    return distances;
  }

  function comparison(repo, base, head) {
    const baseAncestors = ancestry(repo, base);
    const headAncestors = ancestry(repo, head);
    let mergeBase = base;
    for (const sha of headAncestors.keys()) {
      if (baseAncestors.has(sha)) {
        mergeBase = sha;
        break;
      }
    }
    const aheadBy = headAncestors.get(mergeBase) ?? 0;
    const behindBy = baseAncestors.get(mergeBase) ?? 0;
    const status =
      base === head
        ? "identical"
        : baseAncestors.has(head)
          ? "behind"
          : headAncestors.has(base)
            ? "ahead"
            : "diverged";
    const baseFiles = repo.commits.get(base).files;
    const headFiles = repo.commits.get(head).files;
    const files = [...new Set([...baseFiles.keys(), ...headFiles.keys()])]
      .sort()
      .flatMap((filename) => {
        const before = baseFiles.get(filename);
        const after = headFiles.get(filename);
        if (before?.sha === after?.sha) return [];
        return [
          {
            filename,
            status:
              before === undefined
                ? "added"
                : after === undefined
                  ? "removed"
                  : "modified",
            sha: after?.sha ?? before.sha,
          },
        ];
      });
    return {
      status,
      ahead_by: aheadBy,
      behind_by: behindBy,
      total_commits: aheadBy,
      base_commit: { sha: base },
      merge_base_commit: { sha: mergeBase },
      files,
    };
  }

  function seed(body) {
    if (
      typeof body?.owner !== "string" ||
      typeof body?.repo !== "string" ||
      typeof body?.defaultBranch !== "string"
    ) {
      throw new Error("owner, repo, and defaultBranch are required");
    }
    const key = repoKey(body.owner, body.repo);
    const repo = {
      key,
      owner: body.owner,
      name: body.repo,
      defaultBranch: body.defaultBranch,
      refs: new Map(),
      commits: new Map(),
      pulls: new Map(),
      reviews: new Map(),
      reviewComments: new Map(),
      issueComments: new Map(),
      checkRuns: new Map(),
      nextPull: 1,
    };
    const files = flattenTree(body.tree ?? {});
    const sha = commit(repo, null, files, "Seed repository");
    repo.refs.set(fullRef(body.defaultBranch), sha);
    repositories.set(key, repo);
    return {
      owner: body.owner,
      repo: body.repo,
      default_branch: body.defaultBranch,
      sha,
    };
  }

  async function testControl(pathname, method, body, response) {
    if (!pathname.startsWith("/__test/")) return false;
    if (method === "GET" && pathname === "/__test/hits") {
      json(response, 200, hits);
      return true;
    }
    if (method !== "POST") return false;
    if (pathname === "/__test/seed") {
      try {
        json(response, 201, seed(body));
      } catch (error) {
        json(response, 400, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    const repo = repository(body?.owner, body?.repo);
    if (repo === undefined) {
      json(response, 404, { message: "Repository not found" });
      return true;
    }
    const pull = getPull(repo, body.pullNumber);

    if (pathname === "/__test/reviews") {
      if (
        pull === undefined ||
        typeof body.user !== "string" ||
        !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(body.state)
      ) {
        json(response, 422, {
          message: "A valid pull, user, and review state are required",
        });
        return true;
      }
      const submittedAt = now();
      const review = {
        id: nextReview,
        user: user(body.user),
        body: typeof body.body === "string" ? body.body : "",
        state: body.state,
        submitted_at: submittedAt,
        commit_id: repo.refs.get(fullRef(pull.head)),
      };
      nextReview += 1;
      const reviews = repo.reviews.get(pull.number) ?? [];
      reviews.push(review);
      repo.reviews.set(pull.number, reviews);
      pull.reviewers = pull.reviewers.filter(
        (reviewer) => reviewer !== body.user,
      );
      const comments = repo.reviewComments.get(pull.number) ?? [];
      for (const item of body.comments ?? []) {
        comments.push({
          id: nextComment,
          pull_request_review_id: review.id,
          user: user(body.user),
          body: item.body,
          path: item.path,
          line: item.line ?? null,
          created_at: submittedAt,
          updated_at: submittedAt,
        });
        nextComment += 1;
      }
      repo.reviewComments.set(pull.number, comments);
      json(response, 201, review);
      return true;
    }

    if (pathname === "/__test/check-runs") {
      const sha = resolveCommit(repo, body.ref);
      if (sha === undefined || !Array.isArray(body.runs)) {
        json(response, 422, {
          message: "A valid ref and runs array are required",
        });
        return true;
      }
      const runs = body.runs.map((run) => {
        const status =
          run.status ?? (run.conclusion == null ? "in_progress" : "completed");
        const startedAt = now();
        return {
          id: nextCheckRun++,
          name: run.name,
          head_sha: sha,
          status,
          conclusion: run.conclusion ?? null,
          started_at: startedAt,
          completed_at: status === "completed" ? now() : null,
        };
      });
      repo.checkRuns.set(sha, runs);
      json(response, 200, { total_count: runs.length, check_runs: runs });
      return true;
    }

    if (pathname === "/__test/advance-base") {
      const branch = body.branch ?? repo.defaultBranch;
      const ref = fullRef(branch);
      const parent = repo.refs.get(ref);
      if (parent === undefined) {
        json(response, 404, { message: "Branch not found" });
        return true;
      }
      const files = cloneFiles(repo.commits.get(parent).files);
      for (const [path, file] of flattenTree(body.tree ?? {}))
        files.set(path, file);
      const sha = commit(repo, parent, files, "Advance base branch");
      repo.refs.set(ref, sha);
      json(response, 200, refResponse(ref, sha));
      return true;
    }

    if (pathname === "/__test/merge" || pathname === "/__test/close") {
      if (pull === undefined) {
        json(response, 404, { message: "Pull request not found" });
        return true;
      }
      pull.state = "closed";
      pull.closedAt = now();
      if (pathname === "/__test/merge") {
        pull.merged = true;
        pull.mergedAt = pull.closedAt;
        repo.refs.set(fullRef(pull.base), repo.refs.get(fullRef(pull.head)));
      }
      json(response, 200, pullResponse(repo, pull));
      return true;
    }
    return false;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body;
    try {
      body = await readBody(request);
    } catch {
      hits.push({
        method: request.method ?? "UNKNOWN",
        path: url.pathname,
        body: null,
        authorized: false,
      });
      json(response, 400, { message: "Request body must be valid JSON" });
      return;
    }

    const authorized = request.headers.authorization === `Bearer ${token}`;
    hits.push({
      method: request.method ?? "UNKNOWN",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: body ?? null,
      authorized,
    });
    if (!authorized) {
      json(response, 401, { message: "Bad credentials" });
      return;
    }

    if (await testControl(url.pathname, request.method, body, response)) return;

    if (reflectAuthError && !reflected) {
      reflected = true;
      json(response, 500, {
        message: `Reflected authorization: ${request.headers.authorization}`,
      });
      return;
    }

    if (rate !== undefined && rate.remainingResponses > 0) {
      rate.remainingResponses -= 1;
      const headers = {};
      if (rate.retryAfter !== undefined)
        headers["retry-after"] = String(rate.retryAfter);
      if (rate.resetAt !== undefined)
        headers["x-ratelimit-reset"] = String(rate.resetAt);
      if (rate.status === 403) headers["x-ratelimit-remaining"] = "0";
      json(
        response,
        rate.status ?? 429,
        { message: "API rate limit exceeded" },
        headers,
      );
      return;
    }

    if (url.pathname === malformedResponsePath) {
      json(response, 200, { malformed: true });
      return;
    }

    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (match === null) {
      json(response, 404, { message: "Not found" });
      return;
    }
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    const path = match[3];
    const repo = repository(owner, name);
    if (repo === undefined) {
      json(response, 404, { message: "Repository not found" });
      return;
    }

    const refMatch = /^\/git\/ref\/(.+)$/.exec(path);
    if (request.method === "GET" && refMatch !== null) {
      const ref = fullRef(decodeURIComponent(refMatch[1]));
      const sha = repo.refs.get(ref);
      if (sha === undefined)
        json(response, 404, { message: "Reference not found" });
      else json(response, 200, refResponse(ref, sha));
      return;
    }

    if (request.method === "POST" && path === "/git/refs") {
      if (typeof body?.ref !== "string" || typeof body?.sha !== "string") {
        json(response, 422, { message: "ref and sha are required" });
        return;
      }
      if (repo.refs.has(body.ref) || !repo.commits.has(body.sha)) {
        json(response, 422, { message: "Reference cannot be created" });
        return;
      }
      repo.refs.set(body.ref, body.sha);
      json(response, 201, refResponse(body.ref, body.sha));
      return;
    }

    const contentsMatch = /^\/contents\/(.+)$/.exec(path);
    if (request.method === "PUT" && contentsMatch !== null) {
      const filePath = decodeURIComponent(contentsMatch[1]);
      const ref = fullRef(body?.branch ?? repo.defaultBranch);
      const parent = repo.refs.get(ref);
      if (parent === undefined) {
        json(response, 404, { message: "Branch not found" });
        return;
      }
      let content;
      try {
        content = Buffer.from(body.content, "base64").toString("utf8");
      } catch {
        json(response, 422, { message: "content must be base64" });
        return;
      }
      const files = cloneFiles(repo.commits.get(parent).files);
      const existing = files.get(filePath);
      if (
        (existing === undefined && body.sha !== undefined) ||
        (existing !== undefined && body.sha !== existing.sha)
      ) {
        json(response, 409, { message: "File sha does not match" });
        return;
      }
      const file = { content, sha: blobSha(content) };
      files.set(filePath, file);
      const sha = commit(repo, parent, files, body.message);
      repo.refs.set(ref, sha);
      json(response, existing === undefined ? 201 : 200, {
        content: { path: filePath, sha: file.sha },
        commit: { sha, message: body.message },
      });
      return;
    }

    const compareMatch = /^\/compare\/(.+)\.\.\.(.+)$/.exec(path);
    if (request.method === "GET" && compareMatch !== null) {
      const base = resolveCommit(repo, decodeURIComponent(compareMatch[1]));
      const head = resolveCommit(repo, decodeURIComponent(compareMatch[2]));
      if (base === undefined || head === undefined) {
        json(response, 404, { message: "Commit not found" });
      } else {
        json(response, 200, comparison(repo, base, head));
      }
      return;
    }

    if (request.method === "POST" && path === "/pulls") {
      const baseSha = resolveCommit(repo, body?.base);
      const headSha = resolveCommit(repo, body?.head);
      if (baseSha === undefined || headSha === undefined) {
        json(response, 422, { message: "Base or head branch not found" });
        return;
      }
      const number = repo.nextPull++;
      const pull = {
        number,
        state: "open",
        title: body.title,
        body: body.body ?? null,
        draft: body.draft ?? false,
        merged: false,
        mergedAt: null,
        closedAt: null,
        head: body.head,
        headSha,
        base: body.base,
        baseSha,
        reviewers: [],
        teamReviewers: [],
      };
      repo.pulls.set(number, pull);
      repo.reviews.set(number, []);
      repo.reviewComments.set(number, []);
      repo.issueComments.set(number, []);
      json(response, 201, pullResponse(repo, pull));
      return;
    }

    const reviewersMatch = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(path);
    if (request.method === "POST" && reviewersMatch !== null) {
      const pull = getPull(repo, Number(reviewersMatch[1]));
      if (pull === undefined) {
        json(response, 404, { message: "Pull request not found" });
        return;
      }
      pull.reviewers = [
        ...new Set([...pull.reviewers, ...(body.reviewers ?? [])]),
      ];
      pull.teamReviewers = [
        ...new Set([...pull.teamReviewers, ...(body.team_reviewers ?? [])]),
      ];
      json(response, 201, pullResponse(repo, pull));
      return;
    }

    const reviewsMatch = /^\/pulls\/(\d+)\/reviews$/.exec(path);
    if (request.method === "GET" && reviewsMatch !== null) {
      json(response, 200, repo.reviews.get(Number(reviewsMatch[1])) ?? []);
      return;
    }

    const reviewCommentsMatch = /^\/pulls\/(\d+)\/comments$/.exec(path);
    if (request.method === "GET" && reviewCommentsMatch !== null) {
      json(
        response,
        200,
        repo.reviewComments.get(Number(reviewCommentsMatch[1])) ?? [],
      );
      return;
    }

    const issueCommentsMatch = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (issueCommentsMatch !== null && request.method === "GET") {
      json(
        response,
        200,
        repo.issueComments.get(Number(issueCommentsMatch[1])) ?? [],
      );
      return;
    }
    if (issueCommentsMatch !== null && request.method === "POST") {
      const number = Number(issueCommentsMatch[1]);
      if (!repo.pulls.has(number) || typeof body?.body !== "string") {
        json(response, 404, { message: "Issue not found" });
        return;
      }
      const createdAt = now();
      const comment = {
        id: nextComment++,
        user: user("rightmodeler-bot"),
        body: body.body,
        created_at: createdAt,
        updated_at: createdAt,
      };
      const comments = repo.issueComments.get(number) ?? [];
      comments.push(comment);
      repo.issueComments.set(number, comments);
      json(response, 201, comment);
      return;
    }

    const pullMatch = /^\/pulls\/(\d+)$/.exec(path);
    if (pullMatch !== null) {
      const pull = getPull(repo, Number(pullMatch[1]));
      if (pull === undefined) {
        json(response, 404, { message: "Pull request not found" });
        return;
      }
      if (request.method === "GET") {
        json(response, 200, pullResponse(repo, pull));
        return;
      }
      if (request.method === "PATCH" && body?.state === "closed") {
        pull.state = "closed";
        pull.closedAt = now();
        json(response, 200, pullResponse(repo, pull));
        return;
      }
    }

    const checksMatch = /^\/commits\/(.+)\/check-runs$/.exec(path);
    if (request.method === "GET" && checksMatch !== null) {
      const sha = resolveCommit(repo, decodeURIComponent(checksMatch[1]));
      if (sha === undefined) {
        json(response, 404, { message: "Commit not found" });
      } else {
        const runs = repo.checkRuns.get(sha) ?? [];
        json(response, 200, { total_count: runs.length, check_runs: runs });
      }
      return;
    }

    json(response, 404, { message: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    getHits: () => hits.map((hit) => structuredClone(hit)),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function selftest() {
  const token = "selftest-token";
  const stub = await startGithubStub({ port: 0, token });
  const baseUrl = `http://127.0.0.1:${stub.port}`;
  const request = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    if (!response.ok)
      throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
    return response.json();
  };
  const post = (path, body) =>
    request(path, { method: "POST", body: JSON.stringify(body) });
  try {
    const seeded = await post("/__test/seed", {
      owner: "acme",
      repo: "demo",
      defaultBranch: "main",
      tree: { README: "hello" },
    });
    await post("/__test/advance-base", {
      owner: "acme",
      repo: "demo",
      tree: {},
    });
    await post("/repos/acme/demo/git/refs", {
      ref: "refs/heads/change",
      sha: seeded.sha,
    });
    const pull = await post("/repos/acme/demo/pulls", {
      title: "Change",
      body: "Evidence",
      head: "change",
      base: "main",
      draft: true,
    });
    await post(`/repos/acme/demo/pulls/${pull.number}/requested_reviewers`, {
      reviewers: ["owner"],
    });
    await post("/__test/reviews", {
      owner: "acme",
      repo: "demo",
      pullNumber: pull.number,
      user: "owner",
      state: "APPROVED",
      comments: [{ body: "Looks good", path: "README", line: 1 }],
    });
    await post("/__test/check-runs", {
      owner: "acme",
      repo: "demo",
      ref: "change",
      runs: [{ name: "test", conclusion: "success" }],
    });
    await post("/__test/merge", {
      owner: "acme",
      repo: "demo",
      pullNumber: pull.number,
    });
    const state = await request(`/repos/acme/demo/pulls/${pull.number}`);
    if (!state.merged || state.state !== "closed")
      throw new Error("Expected merged pull state");
    if (stub.getHits().length < 8)
      throw new Error("Expected an append-only hit log");
    console.log("ok");
  } finally {
    await stub.close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv.includes("--selftest")) {
    throw new Error("Run with --selftest");
  }
  await selftest();
}
