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

import { FsStore, computeRunSpecDigest } from "@rightmodeler/core";
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
});
