import {
  defaultGitHubAuth,
  githubChannel,
  type GitHubComment,
} from "eve/channels/github";

export const githubAgentMarker = "<!-- eve:github:rightmodeler -->";

const trustedAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
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

export default githubChannel({
  botName,
  turnPolicy: "queue",
  onComment(ctx, comment) {
    if (
      comment.body.includes(githubAgentMarker) ||
      !isTrustedGitHubComment(comment) ||
      comment.author?.type === "Bot" ||
      !hasInvocation(comment.body, botName())
    ) {
      return null;
    }
    return { auth: defaultGitHubAuth(ctx) };
  },
  events: {
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
