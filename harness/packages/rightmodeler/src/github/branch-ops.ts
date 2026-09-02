import { digestFileContent, type FileDigestMap } from "../apply/remediation.js";
import {
  type GithubClient,
  type GithubFileContent,
  GithubHttpError,
  type GithubRef,
} from "./client.js";

export interface BranchRestoreFile {
  readonly path: string;
  readonly content: string;
  readonly contentBytes: Uint8Array;
}

export async function optionalRef(
  githubClient: GithubClient,
  input: Parameters<GithubClient["getRef"]>[0],
): Promise<GithubRef | undefined> {
  try {
    return await githubClient.getRef(input);
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export async function optionalFile(
  githubClient: GithubClient,
  input: Parameters<GithubClient["getFileContent"]>[0],
): Promise<GithubFileContent | undefined> {
  try {
    return await githubClient.getFileContent(input);
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export async function restoreBranch({
  githubClient,
  owner,
  repo,
  branch,
  title,
  files,
  failedDigests,
  unrestored,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly files: readonly BranchRestoreFile[];
  readonly failedDigests: FileDigestMap;
  readonly unrestored: (path: string) => Error;
}): Promise<void> {
  const branchRef = await optionalRef(githubClient, {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  if (branchRef === undefined) return;

  const currentFiles = new Map<string, GithubFileContent | undefined>();
  for (const file of files) {
    const current = await optionalFile(githubClient, {
      owner,
      repo,
      path: file.path,
      ref: branchRef.sha,
    });
    currentFiles.set(file.path, current);
    failedDigests[file.path] =
      current === undefined ? null : digestFileContent(current.contentBytes);
  }
  for (const file of files) {
    const current = currentFiles.get(file.path);
    if (current?.content === file.content) continue;
    await githubClient.createOrUpdateFile({
      owner,
      repo,
      path: file.path,
      message: `Restore after failed ${title}`,
      content: file.content,
      branch,
      ...(current === undefined ? {} : { sha: current.sha }),
    });
  }
  for (const file of files) {
    const restored = await optionalFile(githubClient, {
      owner,
      repo,
      path: file.path,
      ref: branch,
    });
    if (
      restored === undefined ||
      digestFileContent(restored.contentBytes) !==
        digestFileContent(file.contentBytes)
    ) {
      throw unrestored(file.path);
    }
  }
}
