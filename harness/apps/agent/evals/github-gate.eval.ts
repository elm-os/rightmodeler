import { createHmac } from "node:crypto";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import type { GitHubComment } from "eve/channels/github";

import {
  dispatchesGitHubComment,
  githubAgentMarker,
} from "../agent/channels/github.js";

const webhookSecret = "fixture-webhook-secret";
const repository = {
  full_name: "acme/demo",
  id: 1,
  name: "demo",
  owner: { login: "acme" },
};
const sender = { id: 2, login: "octocat", type: "User" };

function fixtureComment(
  association: string,
  body: string,
  authorType = "User",
): GitHubComment {
  return {
    author: {
      htmlUrl: undefined,
      id: 2,
      login: "octocat",
      type: authorType,
      url: undefined,
    },
    body,
    htmlUrl: undefined,
    id: 11,
    raw: { author_association: association },
    url: undefined,
  };
}

async function postGitHubWebhook(
  fetchTarget: (path: string, init?: RequestInit) => Promise<Response>,
  event: string,
  payload: unknown,
  secret = webhookSecret,
): Promise<{ status: number; ignored: boolean | undefined }> {
  const body = JSON.stringify(payload);
  const response = await fetchTarget("/eve/v1/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `${event}-fixture-delivery`,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  const result =
    response.status === 200
      ? ((await response.json()) as { ignored?: boolean })
      : {};
  return { status: response.status, ignored: result.ignored };
}

export default defineEval({
  description:
    "Proves the GitHub comment trust gate and webhook hook registration offline.",
  tags: ["offline"],
  async test(t) {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      t.check(
        dispatchesGitHubComment(
          fixtureComment(association, "@rightmodeler inspect this"),
          "rightmodeler",
        ),
        equals(true),
      );
    }
    t.check(
      dispatchesGitHubComment(
        fixtureComment("NONE", "@rightmodeler inspect this"),
        "rightmodeler",
      ),
      equals(false),
    );
    t.check(
      dispatchesGitHubComment(
        fixtureComment("OWNER", "inspect this"),
        "rightmodeler",
      ),
      equals(false),
    );
    t.check(
      dispatchesGitHubComment(
        fixtureComment("OWNER", `@rightmodeler ${githubAgentMarker}`),
        "rightmodeler",
      ),
      equals(false),
    );
    t.check(
      dispatchesGitHubComment(
        fixtureComment("OWNER", "@rightmodeler inspect this", "Bot"),
        "rightmodeler",
      ),
      equals(false),
    );

    const issueComment = {
      action: "created",
      repository,
      sender,
      issue: { number: 7, pull_request: {} },
      comment: { id: 11, body: "hello", user: sender },
    };
    const pullRequest = {
      action: "synchronize",
      repository,
      sender,
      pull_request: { number: 7, head: { sha: "a".repeat(40) } },
    };
    const checkSuite = {
      action: "completed",
      repository,
      sender,
      check_suite: {
        id: 21,
        status: "completed",
        conclusion: "failure",
        head_sha: "a".repeat(40),
        pull_requests: [{ number: 7 }],
        app: { slug: "github-actions" },
      },
    };
    const workflowRun = {
      action: "completed",
      repository,
      sender,
      workflow_run: {
        id: 22,
        status: "completed",
        conclusion: "failure",
        head_sha: "a".repeat(40),
        pull_requests: [{ number: 7 }],
      },
    };
    const review = {
      action: "submitted",
      repository,
      sender,
      pull_request: { number: 7 },
      review: { state: "changes_requested" },
    };
    const fetchTarget = t.target.fetch.bind(t.target);
    const wrongSecret = await postGitHubWebhook(
      fetchTarget,
      "issue_comment",
      issueComment,
      "wrong-secret",
    );
    t.check(wrongSecret.status, equals(401));
    for (const [event, payload] of [
      ["issue_comment", issueComment],
      ["pull_request", pullRequest],
      ["check_suite", checkSuite],
      ["workflow_run", workflowRun],
    ] as const) {
      const response = await postGitHubWebhook(fetchTarget, event, payload);
      t.check(response.status, equals(200));
      t.check(response.ignored, equals(undefined));
    }
    const ignoredReview = await postGitHubWebhook(
      fetchTarget,
      "pull_request_review",
      review,
    );
    t.check(ignoredReview.status, equals(200));
    t.check(ignoredReview.ignored, equals(true));
    t.succeeded();
  },
});
