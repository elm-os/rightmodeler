import githubExtension from "@github-tools/eve-extension";

export default githubExtension({
  preset: "pr-author",
  exclude: ["mergePullRequest", "createRelease", "createOrUpdateFile"],
});
