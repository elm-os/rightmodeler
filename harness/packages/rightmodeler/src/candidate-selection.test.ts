import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsStore, setupPrefix, verdictKey } from "@rightmodeler/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  estimateReplay,
  readReport,
  runPipeline,
  type PipelineOptions,
} from "./pipeline.js";
import { Reporter } from "./protocol.js";
import {
  putImmutableJson,
  putMutableJson,
  readJson,
  readSetupState,
  writeCheckpoint,
} from "./state.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_CANDIDATE_SELECTION_TEST_API_KEY";
const now = new Date("2026-10-15T00:30:00.000Z");
const recentReleases: Readonly<Record<string, string>> = {
  "acme/free-1": "2026-10-01",
  "acme/lite-1": "2026-10-02",
  "acme/small-1": "2026-10-03",
  "acme/large-1": "2026-10-04",
  "acme/max-1": "2026-10-05",
  "zeta/judge-1": "2026-10-06",
  "yotta/judge-2": "2026-10-07",
};

interface StubProvider {
  readonly port: number;
  close(): Promise<void>;
  getRequests(): Array<Record<string, unknown>>;
}

interface StubProviderModule {
  startStubProvider(input: {
    port: number;
    includeFreeModel?: boolean;
    omitCatalogModels?: string[];
  }): Promise<StubProvider>;
}

const temporaryDirectories: string[] = [];
let stubModule: StubProviderModule;
let stub: StubProvider;

function daysAfter(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

async function project(
  options: {
    readonly released?: Readonly<Record<string, string>>;
    readonly traces?: string;
    readonly port?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-candidates-"));
  temporaryDirectories.push(root);
  const repo = await makeGitFixture(root, demoAppPath, "demo-app");
  const catalogReference = join(root, "reference.json");
  await writeFile(
    catalogReference,
    JSON.stringify({
      data: Object.entries({ ...recentReleases, ...options.released }).map(
        ([id, released]) => ({ id, released: Date.parse(released) / 1000 }),
      ),
    }),
  );
  const warnings: Array<{ code: string; message: string }> = [];
  const base: PipelineOptions = {
    repo,
    store: join(root, "store"),
    traces: options.traces ?? tracesPath,
    baseUrl: `http://127.0.0.1:${options.port ?? stub.port}/v1`,
    apiKeyEnv,
    catalogReference,
    now,
    reporter: new Reporter("json", {
      stdout: () => undefined,
      stderr: (text) => {
        for (const line of text.trim().split("\n")) {
          const value = JSON.parse(line) as {
            event?: string;
            code: string;
            message: string;
          };
          if (value.event === "warning") {
            warnings.push({ code: value.code, message: value.message });
          }
        }
      },
    }),
  };
  const store = new FsStore(base.store!);
  return {
    base,
    store,
    warnings,
    async estimate(overrides: Partial<PipelineOptions> = {}) {
      await runPipeline({ ...base, ...overrides, through: "shortlist" });
      return estimateReplay({ ...base, ...overrides });
    },
    async shortlist(overrides: Partial<PipelineOptions> = {}) {
      await runPipeline({ ...base, ...overrides, through: "shortlist" });
      return stageOutput(store, "shortlist");
    },
  };
}

async function stageOutput(
  store: FsStore,
  stage: string,
): Promise<Record<string, unknown>> {
  const checkpoint = (await readSetupState(store, "project")).stages[stage]!;
  return (await readJson(store, checkpoint.outputKey)) as Record<
    string,
    unknown
  >;
}

describe("candidate selection", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    stubModule = (await import(stubModuleUrl)) as StubProviderModule;
    stub = await stubModule.startStubProvider({ port: 0 });
    process.env[apiKeyEnv] = "fixture-key";
  });

  afterAll(async () => {
    delete process.env[apiKeyEnv];
    await stub.close();
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("shortlists models released in the 90 days before the plan is built, the first day included", async () => {
    const { estimate, warnings } = await project({
      released: {
        "acme/lite-1": "2026-07-17T00:00:00Z",
        "acme/small-1": "2026-07-16T23:59:59Z",
      },
    });

    const estimated = await estimate();

    expect(estimated.releaseWindow).toEqual({
      since: "2026-07-17",
      until: null,
    });
    expect(
      estimated.shortlist.map(({ candidateIds, droppedByReleaseWindow }) => ({
        candidateIds,
        droppedByReleaseWindow,
      })),
    ).toEqual([
      { candidateIds: ["acme/lite-1"], droppedByReleaseWindow: 1 },
      { candidateIds: ["acme/lite-1"], droppedByReleaseWindow: 1 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("stores the window it resolves in the plan, also when candidates are named", async () => {
    const { shortlist } = await project();

    expect(await shortlist()).toMatchObject({
      releasedSince: "2026-07-17",
      releasedUntil: null,
      namedCandidates: [],
    });
    expect(await shortlist({ releasedSince: "180d" })).toMatchObject({
      releasedSince: "2026-04-18",
      releasedUntil: null,
    });
    expect(await shortlist({ releasedSince: "2026-01-01" })).toMatchObject({
      releasedSince: "2026-01-01",
      releasedUntil: null,
    });
    expect(await shortlist({ releasedUntil: "2026-09-30" })).toMatchObject({
      releasedSince: "2026-07-02",
      releasedUntil: "2026-09-30",
    });
    expect(
      await shortlist({ releasedSince: "30d", releasedUntil: "2026-10-01" }),
    ).toMatchObject({
      releasedSince: "2026-09-15",
      releasedUntil: "2026-10-01",
    });
    expect(
      await shortlist({
        namedCandidates: ["small-1", "acme/lite-1", "small-1"],
      }),
    ).toMatchObject({
      releasedSince: "2026-07-17",
      releasedUntil: null,
      namedCandidates: ["acme/lite-1", "small-1"],
    });
  });

  it("replays and reports the window and candidates the estimate showed, on a later day", async () => {
    const { base, store, estimate } = await project({
      released: {
        "acme/lite-1": "2026-07-17T00:00:00Z",
        "acme/small-1": "2026-07-16T23:59:59Z",
      },
    });
    const estimated = await estimate();

    await runPipeline({ ...base, now: daysAfter(now, 30), through: "report" });

    const replay = (await stageOutput(store, "replay")) as {
      releaseWindow?: unknown;
      candidates: Array<{ stepId: string; candidates: Array<{ id: string }> }>;
    };
    expect(replay.releaseWindow).toEqual(estimated.releaseWindow);
    expect(
      replay.candidates.map(({ stepId, candidates }) => ({
        stepId,
        candidateIds: candidates.map(({ id }) => id),
      })),
    ).toEqual(
      estimated.shortlist.map(({ stepId, candidateIds }) => ({
        stepId,
        candidateIds,
      })),
    );
    const { report } = await readReport({ repo: base.repo, store: base.store });
    expect(report.caps).toEqual(
      expect.arrayContaining([
        { name: "released since", value: "2026-07-17" },
        ...estimated.shortlist.map(({ stepId }) => ({
          name: "droppedByReleaseWindow",
          stepId,
          value: 1,
        })),
      ]),
    );
    expect(report.caps.map(({ name }) => name)).not.toContain("released until");
  });

  it("reuses the plan it built for the same inputs on a later day, with that plan's window", async () => {
    const { base, store, shortlist } = await project({
      released: { "acme/lite-1": "2026-07-17T00:00:00Z" },
    });
    const later = daysAfter(now, 7);

    await shortlist();
    await shortlist({ includeFreeModels: true });
    expect(await shortlist({ now: later })).toMatchObject({
      releasedSince: "2026-07-17",
    });
    await expect(
      estimateReplay({ ...base, now: later }),
    ).resolves.toMatchObject({
      releaseWindow: { since: "2026-07-17", until: null },
      shortlist: [
        { candidateIds: ["acme/lite-1", "acme/small-1"] },
        { candidateIds: ["acme/lite-1", "acme/small-1"] },
      ],
    });
    expect(
      (await store.list(`${setupPrefix("project")}shortlist-`)).length,
    ).toBe(2);
  });

  it("keeps the checkpointed plan's window while a re-proof is active, unless a window flag is passed", async () => {
    const { store, shortlist } = await project();
    const later = daysAfter(now, 30);
    await shortlist();
    await putMutableJson(store, verdictKey("project", "summarize"), {
      familyId: "summarize",
      decision: "recommend",
      evaluatorKinds: [],
      reproof_requested: true,
      reproof_request_ids: ["review:7:1"],
    });

    expect(await shortlist({ now: later })).toMatchObject({
      releasedSince: "2026-07-17",
      releasedUntil: null,
    });
    expect(await shortlist({ now: later, releasedSince: "30d" })).toMatchObject(
      { releasedSince: "2026-10-15", releasedUntil: null },
    );
  });

  it("applies no window to a plan written before release windows, and ranks it by price", async () => {
    const freeStub = await stubModule.startStubProvider({
      port: 0,
      includeFreeModel: true,
    });
    try {
      const { base, store, shortlist } = await project({
        port: freeStub.port,
        released: {
          "acme/free-1": "2026-10-10",
          "acme/lite-1": "2026-10-05",
          "acme/small-1": "2026-10-12",
        },
      });
      const legacy = { ...(await shortlist({ includeFreeModels: true })) };
      delete legacy.releasedSince;
      delete legacy.releasedUntil;
      delete legacy.namedCandidates;
      const legacyKey = `${setupPrefix("project")}shortlist-legacy.json`;
      await putImmutableJson(store, legacyKey, legacy);
      const checkpoint = (await readSetupState(store, "project")).stages
        .shortlist!;
      await writeCheckpoint(store, "project", "shortlist", {
        ...checkpoint,
        outputKey: legacyKey,
      });

      await expect(
        estimateReplay({ ...base, includeFreeModels: true }),
      ).resolves.toMatchObject({
        releaseWindow: null,
        shortlist: [
          {
            candidateIds: ["acme/free-1", "acme/lite-1", "acme/small-1"],
            droppedByReleaseWindow: 0,
          },
          {
            candidateIds: ["acme/free-1", "acme/lite-1", "acme/small-1"],
            droppedByReleaseWindow: 0,
          },
        ],
      });
    } finally {
      await freeStub.close();
    }
  });

  it("skips the default window when the catalog has fewer than two release dates, and refuses an explicit range", async () => {
    const { estimate, warnings } = await project({
      released: Object.fromEntries(
        Object.keys(recentReleases).map((id) => [id, "2025-06-01"]),
      ),
    });

    const estimated = await estimate();

    expect(estimated.releaseWindow).toBeNull();
    expect(estimated.shortlist.map(({ candidateIds }) => candidateIds)).toEqual(
      [
        ["acme/lite-1", "acme/small-1"],
        ["acme/lite-1", "acme/small-1"],
      ],
    );
    expect(warnings).toEqual([
      {
        code: "release_window_skipped",
        message:
          "The provider catalog gives its priced models fewer than two distinct release dates, so the default release window (models released on or after 2026-07-17) was not applied and candidates are ranked by price. Pass --catalog-reference with a model list that publishes release dates to apply it.",
      },
    ]);
    await expect(
      estimate({ releasedSince: "2026-01-01" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "release_dates_unavailable",
      message:
        "The provider catalog gives its priced models fewer than two distinct release dates, so --released-since and --released-until cannot be applied.",
      remedy:
        "Pass --catalog-reference <url> with a model list that publishes release dates (for example https://ai-gateway.vercel.sh/v1/models), name the models to try with --candidate <id>, or remove --released-since and --released-until.",
    });
  });

  it("stops before any model call when the window leaves no cheaper model to replay", async () => {
    const { base, estimate, warnings } = await project({
      released: {
        "acme/lite-1": "2026-01-01",
        "acme/small-1": "2026-02-01",
      },
    });
    const chats = stub.getRequests().length;
    const remedy =
      "Pass an earlier --released-since (a date such as 2026-01-01, or a number of days such as 365d), name the models to try with --candidate <id>, or, if the catalog's release dates are placeholders, pass --catalog-reference <url> with a model list that publishes real ones.";

    await expect(estimate()).rejects.toMatchObject({
      exitCode: 2,
      code: "no_recent_candidates",
      message:
        "No model cheaper than a recorded model was released on or after 2026-07-17, so there is nothing to replay.",
      remedy,
    });
    expect(warnings.splice(0)).toEqual([
      {
        code: "shortlist_no_recent_candidates",
        message:
          "Family summarize: no model cheaper than the current model was released on or after 2026-07-17 (2 cheaper models left out); pass an earlier --released-since, or name models with --candidate.",
      },
    ]);
    await expect(
      runPipeline({
        ...base,
        releasedSince: "2026-03-01",
        releasedUntil: "2026-09-30",
        through: "replay",
      }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "no_recent_candidates",
      message:
        "No model cheaper than a recorded model was released between 2026-03-01 and 2026-09-30, so there is nothing to replay.",
      remedy,
    });
    expect(warnings).toEqual([
      {
        code: "shortlist_no_recent_candidates",
        message:
          "Family summarize: no model cheaper than the current model was released between 2026-03-01 and 2026-09-30 (2 cheaper models left out); pass an earlier --released-since, or name models with --candidate.",
      },
    ]);
    expect(stub.getRequests().length).toBe(chats);
  });

  it("counts a single model the window left out in the singular", async () => {
    const { estimate, warnings } = await project({
      released: { "acme/lite-1": "2026-01-01" },
    });
    const policyDirectory = await mkdtemp(
      join(tmpdir(), "rightmodeler-candidates-policy-"),
    );
    temporaryDirectories.push(policyDirectory);
    const policyFilePath = join(policyDirectory, "policy.json");
    await writeFile(
      policyFilePath,
      JSON.stringify({ denyModels: ["acme/small-1"] }),
    );

    await expect(estimate({ policyFilePath })).rejects.toMatchObject({
      code: "no_recent_candidates",
    });
    expect(warnings).toEqual([
      {
        code: "shortlist_no_recent_candidates",
        message:
          "Family summarize: no model cheaper than the current model was released on or after 2026-07-17 (1 cheaper model left out); pass an earlier --released-since, or name models with --candidate.",
      },
    ]);
  });

  it("names every --candidate the catalog does not list", async () => {
    const { estimate } = await project();
    const remedy =
      "Pass each --candidate as the provider's /models list spells it (vendor/model), then rerun.";

    await expect(
      estimate({ namedCandidates: ["acme/nope-1"] }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "unknown_candidate",
      message: "--candidate acme/nope-1 is not in the provider catalog.",
      remedy,
    });
    await expect(
      estimate({ namedCandidates: ["acme/nope-2", "small-1", "acme/nope-1"] }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "unknown_candidate",
      message:
        "--candidate acme/nope-1 is not in the provider catalog; --candidate acme/nope-2 is not in the provider catalog.",
      remedy,
    });
  });

  it("tries named models whatever their release date, and leaves out one a call site cannot use at every step of its family", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-candidate-trace-"));
    temporaryDirectories.push(root);
    const traces = join(root, "traces.json");
    await writeFile(
      traces,
      (await readFile(tracesPath, "utf8")).replace(
        '"gen_ai.usage.output_tokens": 28',
        '"gen_ai.usage.output_tokens": 5000',
      ),
    );
    const { estimate, warnings } = await project({
      traces,
      released: {
        "acme/lite-1": "2025-01-01",
        "acme/small-1": "2025-02-01",
      },
    });
    const reason =
      "its output limit is below the 5000 tokens this call site needs";

    const estimated = await estimate({
      namedCandidates: ["acme/small-1", "lite-1"],
    });

    expect(estimated).toMatchObject({
      releaseWindow: null,
      namedCandidates: ["acme/small-1", "lite-1"],
    });
    expect(estimated.shortlist.map(({ candidateIds }) => candidateIds)).toEqual(
      [["acme/small-1"], ["acme/small-1"]],
    );
    expect(
      estimated.shortlist
        .map(({ namedCandidatesLeftOut }) => namedCandidatesLeftOut ?? [])
        .sort((left, right) => left.length - right.length),
    ).toEqual([[], [{ modelId: "acme/lite-1", reason }]]);
    expect(warnings).toEqual([
      {
        code: "shortlist_candidate_left_out",
        message: `Family summarize: --candidate acme/lite-1 was left out: ${reason}.`,
      },
    ]);
  });

  it("stops when no named model can be tried, giving each model's reason", async () => {
    const { estimate, warnings } = await project();
    const notCheaper =
      "it is not cheaper than the current model acme/large-1 (3 vs 1.5 USD per million tokens)";

    await expect(
      estimate({ namedCandidates: ["acme/max-1", "large-1"] }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "named_candidates_ineligible",
      message: `None of the models named with --candidate can be tried at any call site: acme/large-1: it is the current model; acme/max-1: ${notCheaper}.`,
      remedy:
        "Name models that cost less than the recorded models and support what each call site needs, or remove --candidate to use the automatic shortlist.",
    });
    expect(warnings).toEqual([
      {
        code: "shortlist_candidate_left_out",
        message:
          "Family summarize: --candidate acme/large-1 was left out: it is the current model.",
      },
      {
        code: "shortlist_candidate_left_out",
        message: `Family summarize: --candidate acme/max-1 was left out: ${notCheaper}.`,
      },
    ]);
  });

  it("keeps today's outcome when every step abstains", async () => {
    const absentStub = await stubModule.startStubProvider({
      port: 0,
      omitCatalogModels: ["acme/large-1"],
    });
    try {
      const { estimate, warnings } = await project({ port: absentStub.port });
      for (const overrides of [{}, { namedCandidates: ["acme/small-1"] }]) {
        const estimated = await estimate(overrides);

        expect(
          estimated.shortlist.map(({ candidateIds }) => candidateIds),
        ).toEqual([[], []]);
        expect(warnings.splice(0)).toEqual([
          {
            code: "shortlist_current_model_absent",
            message:
              "Family summarize: Current model is absent from the provider catalog: acme/large-1",
          },
        ]);
      }
    } finally {
      await absentStub.close();
    }
  });
});
