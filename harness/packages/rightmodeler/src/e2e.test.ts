import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type StepRecord } from "@rightmodeler/core";
import { afterAll, describe, expect, it, vi } from "vitest";

import { estimateReplay, runPipeline, topologicalRecords } from "./pipeline.js";
import { Reporter } from "./protocol.js";
import {
  fixtureCopy,
  openaiModelsPath,
  removeTemporaryDirectories,
  renamedModelFixture,
  runCli,
  secret,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

describe("machine error protocol", () => {
  it("preserves a named code from a typed service error", () => {
    let stderr = "";
    const reporter = new Reporter("json", {
      stdout: () => undefined,
      stderr: (value) => {
        stderr += value;
      },
    });
    const error = Object.assign(new Error("active corpus moved"), {
      code: "stale_corpus_parent",
    });

    expect(reporter.error(error)).toBe(10);
    expect(JSON.parse(stderr)).toMatchObject({
      code: "stale_corpus_parent",
      message: "active corpus moved",
    });
  });
});

describe.runIf(process.platform === "win32")("Windows program lookup", () => {
  it("runs Git from PATH, not a git.exe in the current folder", async () => {
    const { root, repo } = await fixtureCopy("planted-git");
    const cwd = join(root, "planted");
    await mkdir(cwd);
    await copyFile(process.execPath, join(cwd, "git.exe"));
    // Drop any opt-out the parent shell set, so the CLI has to set it itself.
    const unset = Object.fromEntries(
      Object.keys(process.env)
        .filter(
          (name) => name.toUpperCase() === "NODEFAULTCURRENTDIRECTORYINEXEPATH",
        )
        .map((name) => [name, undefined]),
    );

    const plan = await runCli(
      ["init", "--plan", "--output", "json", "--repo", repo],
      { cwd, env: unset },
    );

    expect(plan.code, plan.stderr).toBe(0);
  });
});

describe("git preconditions", () => {
  it("names a missing git instead of calling the folder no repository", async () => {
    const { root, repo } = await fixtureCopy("missing-git");
    const empty = join(root, "empty-path");
    await mkdir(empty);
    // Every spelling of PATH, since Windows reads the name in any letter case.
    const path = Object.fromEntries(
      [...Object.keys(process.env), "PATH"]
        .filter((name) => name.toUpperCase() === "PATH")
        .map((name) => [name, empty]),
    );

    const plan = await runCli(
      ["init", "--plan", "--output", "json", "--repo", repo],
      { env: path },
    );

    expect(plan.code, plan.stderr).toBe(2);
    expect(JSON.parse(plan.stderr)).toMatchObject({
      code: "not_git_repository",
      message: expect.stringContaining("Git is not installed"),
    });
  });

  it("names a repository git refuses for its owner, with git's own fix", async () => {
    const { root, repo } = await fixtureCopy("unsafe-owner");

    const plan = await runCli(
      ["init", "--plan", "--output", "json", "--repo", repo],
      {
        env: {
          GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
        },
      },
    );

    expect(plan.code, plan.stderr).toBe(2);
    expect(JSON.parse(plan.stderr)).toMatchObject({
      code: "not_git_repository",
      message: expect.stringContaining("another account owns"),
      remedy: expect.stringContaining(
        "git config --global --add safe.directory",
      ),
    });
  });
});

describe("direct vendor keys", () => {
  it("stops a direct OpenAI key before any chat when only OpenAI models could judge", async () => {
    const { root, repo, traces } = await renamedModelFixture(
      "direct-openai-judge",
      "gpt-6-sol",
    );
    const catalogReference = join(root, "reference.json");
    await writeFile(
      catalogReference,
      JSON.stringify({
        data: [
          {
            id: "openai/gpt-6-sol",
            type: "language",
            context_window: 1_050_000,
            pricing: { input: "0.000002", output: "0.000012" },
          },
          {
            id: "openai/gpt-6-luna",
            type: "language",
            context_window: 1_050_000,
            pricing: { input: "0.0000001", output: "0.0000005" },
          },
          { id: "openai/text-embedding-3-small", type: "embedding" },
        ],
      }),
    );
    const apiKeyEnv = "RIGHTMODELER_DIRECT_OPENAI_KEY";
    const options = {
      repo,
      traces,
      reporter: new Reporter("json", {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv,
      catalogReference,
    };
    const catalogBody = await readFile(openaiModelsPath, "utf8");
    const requested: string[] = [];
    process.env[apiKeyEnv] = secret;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        requested.push(String(input));
        return new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    try {
      await runPipeline({ ...options, through: "shortlist" });

      await expect(estimateReplay(options)).rejects.toMatchObject({
        exitCode: 2,
        code: "no_neutral_judge",
        message: expect.stringContaining(
          "the candidates come from openai and the recorded model from openai",
        ),
      });
      expect(requested).toEqual(["https://api.openai.com/v1/models"]);
    } finally {
      fetchSpy.mockRestore();
      delete process.env[apiKeyEnv];
    }
  }, 60_000);
});

function topologyRecord(
  stepId: string,
  path: string,
  downstreamStepIds: readonly string[],
): StepRecord {
  return {
    stepId,
    callSite: { path, line: 1, matcherSlug: "topology-test" },
    family: "topology-test",
    replayMode: "e2e",
    prefixProvenance: "model_authored",
    riskTier: "normal",
    capabilityRequirements: [],
    evaluatorLadder: [],
    currentModel: "acme/current",
    observedCostUsd: 0,
    downstreamStepIds: [...downstreamStepIds],
    candidates: [],
    analysisHistory: [],
    status: "pending",
    contentHash: `hash-${stepId}`,
  };
}

describe("topologicalRecords", () => {
  it("respects every edge across all four-node DAGs", () => {
    const ids = ["a", "b", "c", "d"] as const;
    const possibleEdges = ids.flatMap((source, sourceIndex) =>
      ids.slice(sourceIndex + 1).map((target) => [source, target] as const),
    );
    for (let mask = 0; mask < 2 ** possibleEdges.length; mask += 1) {
      const records = ids.map((stepId, index) =>
        topologyRecord(
          stepId,
          `${ids.length - index}.py`,
          possibleEdges.flatMap(([source, target], edgeIndex) =>
            source === stepId && (mask & (1 << edgeIndex)) !== 0
              ? [target]
              : [],
          ),
        ),
      );
      for (const input of [
        records,
        [...records].reverse(),
        [records[1]!, records[3]!, records[0]!, records[2]!],
      ]) {
        const ordered = topologicalRecords(input);
        const position = new Map(
          ordered.map(({ stepId }, order) => [stepId, order]),
        );
        for (const [source, target] of possibleEdges) {
          if (
            records
              .find(({ stepId }) => stepId === source)!
              .downstreamStepIds.includes(target)
          ) {
            expect(position.get(source)).toBeLessThan(position.get(target)!);
          }
        }
      }
    }
  });
});

describe("section 18 autonomy boundary", () => {
  it("has no approval helper in apply or watch production paths", async () => {
    const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
    const matches: string[] = [];
    for (const directory of ["apply", "watch"]) {
      for (const entry of await readdir(join(sourceRoot, directory), {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        const content = await readFile(
          join(sourceRoot, directory, entry.name),
          "utf8",
        );
        for (const [index, line] of content.split("\n").entries()) {
          if (/approval/i.test(line)) {
            matches.push(`${directory}/${entry.name}:${index + 1}:${line}`);
          }
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
