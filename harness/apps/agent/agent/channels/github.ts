import {
  defaultGitHubAuth,
  githubChannel,
  type GitHubCiEvent,
  type GitHubComment,
  type GitHubInboundContext,
} from "eve/channels/github";

import { watchPullRequestOnEvent } from "../lib/pr-watch.js";

export const githubAgentMarker = "<!-- eve:github:rightmodeler -->";

const trustedAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const watchedPullRequestActions = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "closed",
]);
const githubCommentBodyMaxLength = 65_536;

export function isTrustedGitHubComment(comment: GitHubComment): boolean {
  const association = comment.raw.author_association;
  return (
    typeof association === "string" && trustedAssociations.has(association)
  );
}

function botName(): string {
  return (
    process.env.RIGHTMODELER_GITHUB_BOT_NAME ??
    process.env.GITHUB_APP_SLUG ??
    "rightmodeler"
  );
}

function hasInvocation(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu").test(body);
}

export function dispatchesGitHubComment(
  comment: GitHubComment,
  name: string,
): boolean {
  return (
    !comment.body.includes(githubAgentMarker) &&
    isTrustedGitHubComment(comment) &&
    comment.author?.type !== "Bot" &&
    hasInvocation(comment.body, name)
  );
}

async function watchPullRequestsFromCiEvent(
  source: string,
  ctx: GitHubInboundContext,
  event: GitHubCiEvent,
): Promise<void> {
  if (event.action !== "completed") return;
  for (const prNumber of event.pullRequests) {
    await watchPullRequestOnEvent(
      source,
      ctx.repository.owner,
      ctx.repository.name,
      prNumber,
    );
  }
}

export default githubChannel({
  botName,
  turnPolicy: "queue",
  onComment(ctx, comment) {
    return dispatchesGitHubComment(comment, botName())
      ? { auth: defaultGitHubAuth(ctx) }
      : null;
  },
  async onPullRequest(ctx, pullRequest) {
    if (watchedPullRequestActions.has(pullRequest.action)) {
      await watchPullRequestOnEvent(
        "pull_request",
        ctx.repository.owner,
        ctx.repository.name,
        pullRequest.pullRequestNumber,
      );
    }
    return null;
  },
  async onCheckSuite(ctx, checkSuite) {
    await watchPullRequestsFromCiEvent("check_suite", ctx, checkSuite);
    return null;
  },
  async onWorkflowRun(ctx, workflowRun) {
    await watchPullRequestsFromCiEvent("workflow_run", ctx, workflowRun);
    return null;
  },
  events: {
    async "turn.started"(_data, channel) {
      try {
        await channel.thread.react("eyes");
      } catch {
        return;
      }
    },
    async "message.completed"(data, channel) {
      if (
        data.message === null ||
        data.message.length === 0 ||
        data.finishReason === "tool-calls"
      ) {
        return;
      }
      const chunkLength =
        githubCommentBodyMaxLength - githubAgentMarker.length - 2;
      for (
        let offset = 0;
        offset < data.message.length;
        offset += chunkLength
      ) {
        await channel.thread.post(
          `${data.message.slice(offset, offset + chunkLength)}\n\n${githubAgentMarker}`,
        );
      }
    },
  },
});
