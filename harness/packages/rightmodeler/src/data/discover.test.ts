import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverTraces, sanitizeClaudeProjectPath } from "./discover.js";

const temporaryDirectories: string[] = [];
const otelTrace = JSON.stringify([
  {
    traceId: "trace-1",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "acme/large-1",
    },
  },
]);
const otelRecord = otelTrace.slice(1, -1);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureRoot(label: string): Promise<{
  root: string;
  repo: string;
  homeDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const homeDir = join(root, "home");
  await Promise.all([
    mkdir(repo, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  return { root, repo, homeDir };
}

describe("trace discovery", () => {
  it("finds adapter-claimed local files newest-first and rejects unrelated JSON", async () => {
    const { repo, homeDir } = await fixtureRoot("local-discovery");
    const conventional = join(repo, "traces.json");
    const nested = join(repo, "traces", "session.jsonl");
    const topLevel = join(repo, "other.jsonl");
    await mkdir(join(repo, "traces"));
    await mkdir(join(repo, "node_modules"));
    await Promise.all([
      writeFile(conventional, otelTrace),
      writeFile(nested, `${otelRecord}\n${otelRecord}\n`),
      writeFile(topLevel, otelTrace),
      writeFile(join(repo, "settings.json"), '{"theme":"light"}'),
      writeFile(join(repo, "node_modules", "hidden.json"), otelTrace),
    ]);
    await Promise.all([
      utimes(conventional, new Date(1_000), new Date(1_000)),
      utimes(nested, new Date(3_000), new Date(3_000)),
      utimes(topLevel, new Date(2_000), new Date(2_000)),
    ]);

    const candidates = await discoverTraces({ repo, homeDir });

    expect(candidates.map(({ path }) => path)).toEqual([
      nested,
      topLevel,
      conventional,
    ]);
    expect(candidates.map(({ format }) => format)).toEqual([
      "otel-genai",
      "otel-genai",
      "otel-genai",
    ]);
    expect(candidates[0]?.approximateRecords).toBe(2);
  });

  it("examines no more than 50 conventional local files", async () => {
    const { repo, homeDir } = await fixtureRoot("file-cap");
    await Promise.all(
      Array.from({ length: 51 }, (_, index) =>
        writeFile(
          join(repo, `trace-${String(index).padStart(2, "0")}.jsonl`),
          otelTrace,
        ),
      ),
    );

    const candidates = await discoverTraces({ repo, homeDir });

    expect(candidates).toHaveLength(50);
    expect(candidates.map(({ path }) => path)).not.toContain(
      join(repo, "trace-50.jsonl"),
    );
  });

  it("does not inspect qualifying content beyond the bounded file head", async () => {
    const { repo, homeDir } = await fixtureRoot("read-cap");
    const hiddenBeyondHead = join(repo, "oversized.jsonl");
    await writeFile(hiddenBeyondHead, `${" ".repeat(300_000)}${otelTrace}\n`);

    expect(await discoverTraces({ repo, homeDir })).toEqual([]);
  });

  it("uses the observed Claude Code project path convention and filters by repo", async () => {
    const { root, repo, homeDir } = await fixtureRoot("claude");
    const otherRepo = join(root, "other.repo");
    const matchingDirectory = join(
      homeDir,
      ".claude",
      "projects",
      sanitizeClaudeProjectPath(repo),
    );
    const otherDirectory = join(
      homeDir,
      ".claude",
      "projects",
      sanitizeClaudeProjectPath(otherRepo),
    );
    await Promise.all([
      mkdir(matchingDirectory, { recursive: true }),
      mkdir(otherDirectory, { recursive: true }),
    ]);
    const matching = join(matchingDirectory, "matching.jsonl");
    const transcript = JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      uuid: "message-1",
      parentUuid: "prompt-1",
      message: {},
    });
    await Promise.all([
      writeFile(matching, `${transcript}\n`),
      writeFile(join(otherDirectory, "other.jsonl"), `${transcript}\n`),
    ]);

    expect(sanitizeClaudeProjectPath("/Users/example/my.repo")).toBe(
      "-Users-example-my-repo",
    );
    expect(sanitizeClaudeProjectPath(`/${"a".repeat(210)}`)).toHaveLength(207);
    expect(sanitizeClaudeProjectPath(`/${"a".repeat(210)}`)).toMatch(
      /-djaaup$/u,
    );
    expect(await discoverTraces({ repo, homeDir })).toMatchObject([
      { path: matching, format: "claude-code", approximateRecords: 1 },
    ]);
  });

  it("reserves discovery capacity for Claude Code transcripts", async () => {
    const { repo, homeDir } = await fixtureRoot("source-budget");
    await Promise.all(
      Array.from({ length: 55 }, (_, index) =>
        writeFile(
          join(repo, `junk-${String(index).padStart(2, "0")}.json`),
          "{}",
        ),
      ),
    );
    const transcriptDirectory = join(
      homeDir,
      ".claude",
      "projects",
      sanitizeClaudeProjectPath(repo),
    );
    await mkdir(transcriptDirectory, { recursive: true });
    const transcript = join(transcriptDirectory, "session.jsonl");
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "session-1",
        uuid: "message-1",
        parentUuid: "prompt-1",
        message: {},
      })}\n`,
    );

    expect(await discoverTraces({ repo, homeDir })).toMatchObject([
      { path: transcript, format: "claude-code" },
    ]);
  });

  it("does not follow a traces directory symlink outside the repository", async () => {
    const { root, repo, homeDir } = await fixtureRoot("traces-symlink");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "outside.json"), otelTrace);
    await symlink(outside, join(repo, "traces"));
    const healthy = join(repo, "traces.json");
    await writeFile(healthy, otelTrace);

    expect(await discoverTraces({ repo, homeDir })).toMatchObject([
      { path: healthy },
    ]);
  });

  it("finds only Codex sessions whose session metadata cwd matches the repo", async () => {
    const { root, repo, homeDir } = await fixtureRoot("codex");
    const sessions = join(homeDir, ".codex", "sessions", "2026", "08", "15");
    await mkdir(sessions, { recursive: true });
    const matching = join(sessions, "rollout-matching.jsonl");
    const codexSession = (cwd: string): string =>
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "session-1",
            cwd,
            cli_version: "0.1.0",
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "turn-1", model: "acme/large-1" },
        }),
      ].join("\n");
    await Promise.all([
      writeFile(matching, `${codexSession(resolve(repo))}\n`),
      writeFile(
        join(sessions, "rollout-other.jsonl"),
        `${codexSession(resolve(root, "other"))}\n`,
      ),
    ]);

    expect(await discoverTraces({ repo, homeDir })).toMatchObject([
      { path: matching, format: "codex", approximateRecords: 2 },
    ]);
  });
});
