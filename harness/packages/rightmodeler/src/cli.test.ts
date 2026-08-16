import { copyFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "./cli.js";
import type { CliIo } from "./protocol.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const temporaryDirectories: string[] = [];
const validTracePath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const emptyCodexSession = [
  JSON.stringify({
    type: "session_meta",
    payload: {
      id: "session-1",
      cwd: "/unused",
      cli_version: "0.1.0",
      model_provider: "openai",
    },
  }),
  JSON.stringify({
    type: "turn_context",
    payload: { turn_id: "turn-1", model: "acme/large-1" },
  }),
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  repo: string;
  homeDir: string;
  newest: string;
  older: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-cli-guidance-"));
  temporaryDirectories.push(root);
  const repo = await makeGitFixture(root);
  const homeDir = join(root, "home");
  const newest = join(repo, "newest.jsonl");
  const older = join(repo, "older.json");
  await Promise.all([
    writeFile(newest, `${emptyCodexSession}\n`),
    copyFile(validTracePath, older),
  ]);
  await Promise.all([
    utimes(newest, new Date(2_000), new Date(2_000)),
    utimes(older, new Date(1_000), new Date(1_000)),
  ]);
  return { root, repo, homeDir, newest, older };
}

function captureIo(): { io: CliIo; stdout(): string; stderr(): string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runtime(
  homeDir: string,
  answer: string,
  isTTY: true | undefined,
): {
  runtime: Parameters<typeof executeCli>[2];
  runtimeOutput(): string;
} {
  let runtimeOutput = "";
  const stdin = Object.assign(Readable.from([answer]), { isTTY });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        runtimeOutput += String(chunk);
        callback();
      },
    }),
    { isTTY },
  );
  return {
    runtime: {
      stdin,
      stdout,
      env: {},
      homeDir,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    },
    runtimeOutput: () => runtimeOutput,
  };
}

describe("CLI trace guidance wiring", () => {
  it("prompts through injected IO in a TTY and uses the selected candidate", async () => {
    const { repo, homeDir, older } = await fixture();
    const captured = captureIo();
    const terminal = runtime(homeDir, "2\n", true);

    const code = await executeCli(
      ["init", "--through", "ingest", "--repo", repo],
      captured.io,
      terminal.runtime,
    );

    expect(captured.stderr()).toBe("");
    expect(code).toBe(0);
    expect(captured.stdout()).toContain("Choose a trace file");
    expect(captured.stdout()).toContain("./older.json");
    expect(terminal.runtimeOutput()).toBe("");
  });

  it("does not prompt when isTTY is undefined", async () => {
    const { repo, homeDir } = await fixture();
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "2\n", undefined);

    const code = await executeCli(
      ["init", "--through", "ingest", "--repo", repo],
      captured.io,
      nonTerminal.runtime,
    );

    expect(code).toBe(2);
    expect(captured.stdout()).not.toContain("Choose a trace file");
    expect(captured.stderr()).toContain("A trace input path is required");
  });

  it("names the trace adopted by --yes in human output", async () => {
    const { repo, homeDir, newest } = await fixture();
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "", undefined);

    const code = await executeCli(
      ["init", "--yes", "--through", "ingest", "--repo", repo],
      captured.io,
      nonTerminal.runtime,
    );

    expect(code).toBe(2);
    expect(captured.stdout()).toContain(`Using trace file: ${newest}`);
    expect(captured.stderr()).toContain(
      "Rerun the command and choose a different trace file.",
    );
  });

  it("caps the non-interactive candidate remedy at the newest three paths", async () => {
    const { repo, homeDir, newest, older } = await fixture();
    const extras = await Promise.all(
      ["third.json", "fourth.json", "fifth.json"].map(async (name, index) => {
        const path = join(repo, name);
        await copyFile(validTracePath, path);
        await utimes(
          path,
          new Date(5_000 - index * 1_000),
          new Date(5_000 - index * 1_000),
        );
        return path;
      }),
    );
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "", undefined);

    expect(
      await executeCli(
        ["init", "--through", "ingest", "--repo", repo],
        captured.io,
        nonTerminal.runtime,
      ),
    ).toBe(2);
    expect(captured.stderr()).toContain(
      `Found 5 candidate trace files: ${extras.join(", ")}, and 2 more.`,
    );
    expect(captured.stderr()).not.toContain(newest);
    expect(captured.stderr()).not.toContain(older);
  });

  it("registers --yes on estimate", async () => {
    const captured = captureIo();

    expect(await executeCli(["estimate", "--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("--yes");
  });
});
