import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FsStore, compareText, computeRunSpecDigest } from "@rightmodeler/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runPipeline, type PipelineOptions } from "./pipeline.js";
import { Reporter } from "./protocol.js";
import { readSetupState, writeCheckpoint } from "./state.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const traceFixturePath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_STALENESS_TEST_API_KEY";
const baselineStages = [
  "scan",
  "ingest",
  "reconcile",
  "scrub",
  "corpus",
  "audit-sample",
  "shortlist",
];
const cases = [
  { name: "no input change", mutation: "none", expected: [] },
  {
    name: "trace bytes change",
    mutation: "trace-bytes",
    expected: [
      "ingest",
      "reconcile",
      "scrub",
      "corpus",
      "audit-sample",
      "shortlist",
    ],
  },
  {
    name: "an unrelated repository file is added",
    mutation: "unrelated-file",
    expected: ["scan"],
  },
  {
    name: "a matched call site shifts",
    mutation: "matched-call-site",
    expected: [
      "scan",
      "reconcile",
      "scrub",
      "corpus",
      "audit-sample",
      "shortlist",
    ],
  },
  {
    name: "a matcher changes without changing scan records",
    mutation: "matchers",
    expected: ["scan"],
  },
  {
    name: "a trace file is added to a directory",
    mutation: "trace-directory",
    expected: ["ingest"],
  },
  {
    name: "the Mode B step map changes",
    mutation: "mode-b-step-map",
    expected: ["reconcile", "scrub", "corpus", "audit-sample", "shortlist"],
  },
  {
    name: "free models are included",
    mutation: "include-free-models",
    expected: ["shortlist"],
  },
  {
    name: "the release policy changes",
    mutation: "policy-file",
    expected: ["shortlist"],
  },
  {
    name: "an approved run digest is missing",
    mutation: "missing-approved-run",
    expected: ["shortlist"],
  },
] as const;

interface StubProvider {
  readonly port: number;
  close(): Promise<void>;
}

interface StubProviderModule {
  startStubProvider(input: { port: number }): Promise<StubProvider>;
}

const temporaryDirectories: string[] = [];
let stub: StubProvider;
const execFileAsync = promisify(execFile);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function repositoryDigest(repo: string): Promise<string> {
  const git = async (args: readonly string[]) =>
    (await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8" }))
      .stdout;
  const paths = (
    await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  )
    .split("\0")
    .filter((path) => path.length > 0)
    .sort(compareText);
  return computeRunSpecDigest({
    revision: (await git(["rev-parse", "--verify", "HEAD"])).trim(),
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: sha256(await readFile(join(repo, path))),
      })),
    ),
  });
}

function startedStages(reporter: Reporter): string[] {
  return reporter.events
    .filter((event) => event.event === "stage_started")
    .map((event) => event.stage);
}

describe("pipeline staleness", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const stubModule = (await import(stubModuleUrl)) as StubProviderModule;
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

  it.each(cases)("$name", async ({ mutation, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-staleness-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const store = join(root, "store");
    const traceFixture = await readFile(traceFixturePath);
    const traces =
      mutation === "trace-directory"
        ? join(root, "traces")
        : join(root, "traces.jsonl");
    if (mutation === "trace-directory") {
      await mkdir(traces);
      await writeFile(join(traces, "first.json"), traceFixture);
    } else {
      await writeFile(traces, traceFixture);
    }

    async function run(
      overrides: Partial<PipelineOptions> = {},
    ): Promise<string[]> {
      const reporter = new Reporter("json", {
        stdout: () => undefined,
        stderr: () => undefined,
      });
      await runPipeline({
        repo,
        store,
        traces,
        baseUrl: `http://127.0.0.1:${stub.port}/v1`,
        apiKeyEnv,
        through: "shortlist",
        reporter,
        ...overrides,
      });
      return startedStages(reporter);
    }

    const baselineOverrides: Partial<PipelineOptions> =
      mutation === "trace-directory" ? { through: "ingest" } : {};
    expect(await run(baselineOverrides)).toEqual(
      mutation === "trace-directory" ? ["scan", "ingest"] : baselineStages,
    );

    let overrides = baselineOverrides;
    if (mutation === "trace-bytes") {
      await appendFile(traces, "\n");
    }
    if (mutation === "unrelated-file") {
      await mkdir(join(repo, "docs"), { recursive: true });
      await writeFile(join(repo, "docs", "unrelated-note.md"), "Unrelated\n");
    }
    if (mutation === "matched-call-site") {
      const path = join(repo, "src", "summarize.ts");
      await writeFile(path, `// shifted\n${await readFile(path, "utf8")}`);
    }
    if (mutation === "matchers") {
      const matchersPath = join(root, "matchers.json");
      await writeFile(
        matchersPath,
        JSON.stringify([
          {
            slug: "custom-model-call",
            description: "Custom model call",
            noiseTier: "normal",
            filePatterns: ["**/*.ts"],
            patterns: [
              {
                regex: { source: "customCall\\s*\\(", flags: "i" },
                label: "custom call",
              },
            ],
            examples: ["customCall(input)"],
            closesSurfaceIds: ["custom-framework"],
          },
        ]),
      );
      overrides = { matchersPath };
    }
    if (mutation === "trace-directory") {
      await writeFile(join(traces, "second.json"), traceFixture);
    }
    if (mutation === "mode-b-step-map") {
      const stored = new FsStore(store);
      const scanKeys = await stored.list("project/setup/scan-");
      const entry = await stored.get(scanKeys.at(-1)!);
      const artifact = JSON.parse(
        Buffer.from(entry!.body).toString("utf8"),
      ) as { records: Array<{ stepId: string }> };
      const modeBConfigPath = join(root, "mode-b.json");
      await writeFile(
        modeBConfigPath,
        JSON.stringify({
          version: "1",
          image: "acme/app:test",
          appSpec: { mountPath: ".", command: ["true", "{caseFile}"] },
          stepMap: Object.fromEntries(
            artifact.records.map(({ stepId }, index) => [
              stepId,
              `header-${index}`,
            ]),
          ),
        }),
      );
      overrides = { modeBConfigPath };
    }
    if (mutation === "include-free-models") {
      overrides = { includeFreeModels: true };
    }
    if (mutation === "policy-file") {
      const policyFilePath = join(root, "policy.json");
      await writeFile(policyFilePath, JSON.stringify({ shortlistTop: 5 }));
      overrides = { policyFilePath };
    }
    if (mutation === "missing-approved-run") {
      const reporter = new Reporter("json", {
        stdout: () => undefined,
        stderr: () => undefined,
      });
      await expect(
        run({ approvedRunSpecDigest: "no-such-run", reporter }),
      ).rejects.toThrow("Expected one merged approved swap");
      expect(startedStages(reporter)).toEqual(expected);
      return;
    }

    expect(await run(overrides)).toEqual(expected);
  });

  it("re-reads traces an older reader ingested", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-staleness-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const store = join(root, "store");
    const traces = join(root, "traces.json");
    const traceBytes = await readFile(traceFixturePath);
    await writeFile(traces, traceBytes);
    const ingest = async () =>
      (
        await runPipeline({
          repo,
          store,
          traces,
          through: "ingest",
          reporter: new Reporter("json", {
            stdout: () => undefined,
            stderr: () => undefined,
          }),
        })
      ).executedStages;

    expect(await ingest()).toContain("ingest");
    const fsStore = new FsStore(store);
    const checkpoint = (await readSetupState(fsStore, "project")).stages
      .ingest!;
    await writeCheckpoint(fsStore, "project", "ingest", {
      ...checkpoint,
      inputDigest: computeRunSpecDigest({
        stage: "ingest",
        traceSha256: createHash("sha256").update(traceBytes).digest("hex"),
      }),
    });

    expect(await ingest()).toContain("ingest");
  });

  it("recomputes scan and reconcile checkpoints written before trace-key binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-staleness-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const store = join(root, "store");
    const traces = join(root, "traces.json");
    await writeFile(traces, await readFile(traceFixturePath));
    const reconcile = async () =>
      (
        await runPipeline({
          repo,
          store,
          traces,
          through: "reconcile",
          reporter: new Reporter("json", {
            stdout: () => undefined,
            stderr: () => undefined,
          }),
        })
      ).executedStages;

    expect(await reconcile()).toContain("reconcile");
    const fsStore = new FsStore(store);
    const { stages } = await readSetupState(fsStore, "project");
    const repository = await repositoryDigest(repo);
    expect(stages.scan!.inputDigest).toBe(
      computeRunSpecDigest({
        stage: "scan",
        repository,
        scanner: "scan-trace-key-v1",
      }),
    );
    const scanArtifact = await fsStore.get(stages.scan!.outputKey);
    await writeCheckpoint(fsStore, "project", "scan", {
      ...stages.scan!,
      inputDigest: repository,
    });
    await writeCheckpoint(fsStore, "project", "reconcile", {
      ...stages.reconcile!,
      inputDigest: computeRunSpecDigest({
        stage: "reconcile",
        upstream: stages.ingest!.inputDigest,
        scan: sha256(scanArtifact!.body),
      }),
    });

    expect(await reconcile()).toEqual(
      expect.arrayContaining(["scan", "reconcile"]),
    );
  });

  it("recomputes reconcile checkpoints written before unsendable cases were left out", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-staleness-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const store = join(root, "store");
    const traces = join(root, "traces.json");
    await writeFile(traces, await readFile(traceFixturePath));
    const reconcile = async () =>
      (
        await runPipeline({
          repo,
          store,
          traces,
          through: "reconcile",
          reporter: new Reporter("json", {
            stdout: () => undefined,
            stderr: () => undefined,
          }),
        })
      ).executedStages;

    expect(await reconcile()).toContain("reconcile");
    const fsStore = new FsStore(store);
    const { stages } = await readSetupState(fsStore, "project");
    const scanArtifact = await fsStore.get(stages.scan!.outputKey);
    await writeCheckpoint(fsStore, "project", "reconcile", {
      ...stages.reconcile!,
      inputDigest: computeRunSpecDigest({
        stage: "reconcile",
        upstream: stages.ingest!.inputDigest,
        scan: sha256(scanArtifact!.body),
        binding: "trace-match-v1",
      }),
    });

    expect(await reconcile()).toContain("reconcile");
  });

  it("keeps a built-in judge store's replay checkpoint digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-staleness-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const store = join(root, "store");
    const traces = join(root, "traces.json");
    await writeFile(traces, await readFile(traceFixturePath));
    await runPipeline({
      repo,
      store,
      traces,
      baseUrl: `http://127.0.0.1:${stub.port}/v1`,
      apiKeyEnv,
      through: "replay",
      reporter: new Reporter("json", {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    });
    const { stages } = await readSetupState(new FsStore(store), "project");

    expect(stages.replay!.inputDigest).toBe(
      computeRunSpecDigest({
        stage: "replay",
        upstream: stages.shortlist!.inputDigest,
        provider: computeRunSpecDigest({
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          apiKeyEnv,
          maxCostUsd: null,
          evaluatorPlan: {
            evaluatorKind: "judge",
            gateMetric: "replacement-quality",
          },
        }),
        approvedRunSpecDigest: null,
      }),
    );
  });
});
