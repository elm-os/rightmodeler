import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsStore } from "@rightmodeler/core";
import { describe, expect, it } from "vitest";

import {
  FormatDetectionError,
  TraceAdaptError,
  TraceParseError,
  detectFormat,
  openAiJsonlAdapter,
  otelGenAiAdapter,
  parseTraceRecords,
  traceAdapters,
  type NamedTraceAdapter,
} from "./adapters.js";
import {
  MIN_AUDITED_PER_FAMILY,
  auditSample,
  auditTabulate,
  type AuditWorksheet,
} from "./audit.js";
import { buildCorpus, writeCorpus } from "./corpus.js";
import { type NormalizedRun } from "./normalized-run.js";
import { ScrubError, scrubRuns } from "./scrub.js";

const otelFixtureUrl = new URL(
  "../../../../fixtures/traces/otel-genai.json",
  import.meta.url,
);
const openAiFixtureUrl = new URL(
  "../../../../fixtures/traces/openai.jsonl",
  import.meta.url,
);

async function fixture(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

async function otelRuns(): Promise<NormalizedRun[]> {
  return otelGenAiAdapter.adapt(
    parseTraceRecords(await fixture(otelFixtureUrl)),
  );
}

describe("trace adapters", () => {
  it("detects each supported fixture without cross-detecting OTel as JSONL", async () => {
    const otel = await fixture(otelFixtureUrl);
    const openAi = await fixture(openAiFixtureUrl);

    expect(detectFormat(otel, traceAdapters)).toBe(otelGenAiAdapter);
    expect(detectFormat(openAi, traceAdapters)).toBe(openAiJsonlAdapter);
    expect(openAiJsonlAdapter.detect(otel)).toBe(0);
  });

  it("reports both candidates instead of guessing on ambiguous input", () => {
    const adapters: readonly NamedTraceAdapter[] = [
      { name: "otel-genai", detect: () => 0.8, adapt: () => [] },
      { name: "openai-jsonl", detect: () => 0.75, adapt: () => [] },
    ];

    expect(() => detectFormat("{}", adapters)).toThrowError(
      expect.objectContaining({
        name: "FormatDetectionError",
        reason: "ambiguous",
        candidates: [
          { name: "otel-genai", confidence: 0.8 },
          { name: "openai-jsonl", confidence: 0.75 },
        ],
      }) as FormatDetectionError,
    );
  });

  it("reports both candidates when every format is below threshold", () => {
    try {
      detectFormat("{}", traceAdapters);
      expect.fail("format detection should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(FormatDetectionError);
      expect(error).toMatchObject({
        reason: "below_threshold",
        candidates: expect.arrayContaining([
          { name: "otel-genai", confidence: 0 },
          { name: "openai-jsonl", confidence: 0 },
        ]),
      });
    }
  });

  it("fails loudly on malformed trace records", () => {
    expect(() => parseTraceRecords('{"messages": []}\nnot-json')).toThrow(
      TraceParseError,
    );
    expect(() => otelGenAiAdapter.adapt({})).toThrow(TraceAdaptError);
  });

  it("groups OTel spans into ordered shared-trace trajectories", async () => {
    const records = parseTraceRecords(await fixture(otelFixtureUrl));
    const runs = otelGenAiAdapter.adapt(records);
    const trajectory = runs.find((run) => run.traceId === "trace-trajectory-a");

    expect(runs).toHaveLength(12);
    expect(trajectory?.steps).toHaveLength(2);
    expect(trajectory?.steps.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(trajectory?.steps.map((step) => step.trajectoryId)).toEqual([
      "trace-trajectory-a",
      "trace-trajectory-a",
    ]);
    expect(trajectory?.steps.map((step) => step.family)).toEqual([
      "summarize",
      "support",
    ]);

    const sharedRecords = records.filter(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        "traceId" in record &&
        record.traceId === "trace-trajectory-a",
    ) as Record<string, unknown>[];
    const reverseTimed = [
      { ...sharedRecords[1], startTimeUnixNano: "200" },
      { ...sharedRecords[0], startTimeUnixNano: "100" },
    ];
    expect(
      otelGenAiAdapter.adapt(reverseTimed)[0]?.steps.map((step) => step.family),
    ).toEqual(["summarize", "support"]);
  });

  it("fails loudly when a multi-span trajectory lacks a start time", async () => {
    const records = parseTraceRecords(await fixture(otelFixtureUrl));
    const trajectory = records.filter(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        "traceId" in record &&
        record.traceId === "trace-trajectory-a",
    ) as Record<string, unknown>[];
    const missingTime = trajectory.map((record) => ({ ...record }));
    delete missingTime[0]!.startTimeUnixNano;

    expect(() => otelGenAiAdapter.adapt(missingTime)).toThrowError(
      expect.objectContaining({
        name: "TraceAdaptError",
        message: expect.stringMatching(/start time/i),
      }) as TraceAdaptError,
    );
  });

  it("adapts future operation names and uses the v0 family fallback", async () => {
    const records = parseTraceRecords(await fixture(otelFixtureUrl));
    const source = records[0] as Record<string, unknown>;
    const sourceAttributes = source.attributes as Record<string, unknown>;
    const attributes: Record<string, unknown> = {
      ...sourceAttributes,
      "gen_ai.operation.name": "future_inference_operation",
      "gen_ai.prompt.name": "fallback-family",
    };
    delete attributes["rightmodeler.family"];

    const [run] = otelGenAiAdapter.adapt([{ ...source, attributes }]);

    expect(run?.steps[0]?.family).toBe("fallback-family");
  });

  it("adapts captured OpenAI request-response pairs", async () => {
    const runs = openAiJsonlAdapter.adapt(
      parseTraceRecords(await fixture(openAiFixtureUrl)),
    );
    const support = runs.find((run) => run.traceId === "support-001");

    expect(runs).toHaveLength(8);
    expect(support?.steps[0]).toMatchObject({
      model: "acme/large-1",
      family: "support",
      usage: { inputTokens: 41, outputTokens: 19 },
      trajectoryId: "support-001",
    });
    expect(JSON.stringify(support?.steps[0]?.output)).toContain("lookup_order");
  });
});

describe("scrubRuns", () => {
  it("redacts the planted email and phone before returning runs", async () => {
    const result = scrubRuns(await otelRuns());
    const runIndex = result.runs.findIndex(
      (run) => run.traceId === "trace-support-pii-01",
    );
    const scrubbed = JSON.stringify(result.runs[runIndex]);

    expect(scrubbed).toContain("[REDACTED:email]");
    expect(scrubbed).toContain("[REDACTED:phone]");
    expect(scrubbed).not.toContain("demo.person@example.test");
    expect(scrubbed).not.toContain("+1-202-555-0147");
    expect(result.redactions).toEqual(
      expect.arrayContaining([
        { runIndex, stepIndex: 0, kind: "email" },
        { runIndex, stepIndex: 0, kind: "phone" },
      ]),
    );
  });

  it("wraps invalid normalized input failures as ScrubError", () => {
    const malformed = [
      {
        version: "2",
        traceId: "trace",
        sourceFormat: "test",
      },
    ] as unknown as NormalizedRun[];

    expect(() => scrubRuns(malformed)).toThrow(ScrubError);
  });
});

describe("corpus", () => {
  it("is content deterministic and persists normalized stratum weights", async () => {
    const runs = scrubRuns(await otelRuns()).runs;
    const first = buildCorpus(runs, { seed: 42 });
    const second = buildCorpus([...runs].reverse(), { seed: 42 });
    const corpusShare = first.strata.reduce(
      (total, weight) => total + weight.corpusShare,
      0,
    );
    const trafficShare = first.strata.reduce(
      (total, weight) => total + weight.trafficShare,
      0,
    );

    expect(second.corpusVersionId).toBe(first.corpusVersionId);
    expect(second.cases).toEqual(first.cases);
    expect(first.strata).toEqual([
      { family: "summarize", corpusShare: 0.5, trafficShare: 0.5 },
      { family: "support", corpusShare: 0.5, trafficShare: 0.5 },
    ]);
    expect(
      first.cases.every(
        (corpusCase) =>
          corpusCase.split === "shortlist" || corpusCase.split === "holdout",
      ),
    ).toBe(true);
    expect(corpusShare).toBeCloseTo(1, 12);
    expect(trafficShare).toBeCloseTo(1, 12);
  });

  it("keeps corpus share distinct from observed run traffic share", () => {
    const runs: NormalizedRun[] = [
      {
        version: "2",
        traceId: "summarize-run",
        sourceFormat: "test",
        steps: [
          {
            stepIndex: 0,
            model: "model",
            messages: ["first"],
            output: "first output",
            usage: { inputTokens: 1, outputTokens: 1 },
            trajectoryId: "summarize-run",
            family: "summarize",
          },
          {
            stepIndex: 1,
            model: "model",
            messages: ["second"],
            output: "second output",
            usage: { inputTokens: 1, outputTokens: 1 },
            trajectoryId: "summarize-run",
            family: "summarize",
          },
        ],
      },
      {
        version: "2",
        traceId: "support-run",
        sourceFormat: "test",
        steps: [
          {
            stepIndex: 0,
            model: "model",
            messages: ["support"],
            output: "support output",
            usage: { inputTokens: 1, outputTokens: 1 },
            trajectoryId: "support-run",
            family: "support",
          },
        ],
      },
    ];

    expect(buildCorpus(runs, { seed: 42 }).strata).toEqual([
      {
        family: "summarize",
        corpusShare: 2 / 3,
        trafficShare: 1 / 2,
      },
      {
        family: "support",
        corpusShare: 1 / 3,
        trafficShare: 1 / 2,
      },
    ]);
  });

  it("keeps corpus identity stable when spans are permuted within a trajectory", async () => {
    const records = parseTraceRecords(await fixture(otelFixtureUrl));
    const permuted = [...records];
    const indexes = permuted.flatMap((record, index) =>
      typeof record === "object" &&
      record !== null &&
      "traceId" in record &&
      record.traceId === "trace-trajectory-a"
        ? [index]
        : [],
    );
    const [firstIndex, secondIndex] = indexes;
    if (firstIndex === undefined || secondIndex === undefined) {
      throw new Error("fixture trajectory is incomplete");
    }
    [permuted[firstIndex], permuted[secondIndex]] = [
      permuted[secondIndex],
      permuted[firstIndex],
    ];

    const original = buildCorpus(
      scrubRuns(otelGenAiAdapter.adapt(records)).runs,
      { seed: 42 },
    );
    const reordered = buildCorpus(
      scrubRuns(otelGenAiAdapter.adapt(permuted)).runs,
      { seed: 42 },
    );

    expect(reordered.corpusVersionId).toBe(original.corpusVersionId);
    expect(reordered.cases).toEqual(original.cases);
  });

  it("writes each case and manifest immutably and resumes idempotently", async () => {
    const storeRoot = await mkdtemp(
      join(tmpdir(), "rightmodeler-corpus-test-"),
    );
    const store = new FsStore(storeRoot);
    const corpus = buildCorpus(scrubRuns(await otelRuns()).runs, { seed: 7 });

    try {
      await writeCorpus(store, "project", corpus);
      await writeCorpus(store, "project", corpus);
      expect(await store.list("project/cases/")).toHaveLength(
        corpus.cases.length,
      );
      const manifest = await store.get(
        `project/corpus/corpus-${corpus.corpusVersionId}.json`,
      );
      expect(
        JSON.parse(Buffer.from(manifest!.body).toString("utf8")).strata,
      ).toEqual(corpus.strata);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});

describe("reference audit", () => {
  it("samples accepted references with blank human review fields only", async () => {
    const worksheet = auditSample(scrubRuns(await otelRuns()).runs, {
      size: 5,
      seed: 12,
    });

    expect(worksheet.cases).toHaveLength(5);
    expect(worksheet.cases.every((entry) => entry.verdict === "")).toBe(true);
    expect(worksheet.cases.every((entry) => entry.note === "")).toBe(true);
    expect(worksheet.cases.every((entry) => "acceptedOutput" in entry)).toBe(
      true,
    );
    for (const entry of worksheet.cases) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "acceptedOutput",
          "caseId",
          "family",
          "messages",
          "note",
          ...(entry.systemPrompt === undefined ? [] : ["systemPrompt"]),
          "verdict",
        ].sort(),
      );
    }
  });

  it("counts incorrect and ambiguous verdicts as hand-computed disagreement", () => {
    const verdicts = [
      "incorrect",
      "ambiguous",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ] as const;
    const worksheet: AuditWorksheet = {
      seed: 1,
      populationSize: verdicts.length,
      cases: verdicts.map((verdict, index) => ({
        caseId: `case-${index}`,
        family: "support",
        messages: [],
        acceptedOutput: "accepted reference",
        verdict,
        note: "",
      })),
    };

    const result = auditTabulate(worksheet).perFamily.support;
    expect(MIN_AUDITED_PER_FAMILY).toBe(10);
    expect(result).toMatchObject({
      n: 10,
      disagreement: 0.2,
      referenceAgreementPoint: 0.8,
    });
    expect(result?.wilsonLow).toBeCloseTo(0.0566821514015734, 12);
    expect(result?.wilsonHigh).toBeCloseTo(0.5098375287101421, 12);
  });

  it("names why a sparse family has no reference agreement point", () => {
    const worksheet: AuditWorksheet = {
      seed: 1,
      populationSize: 1,
      cases: [
        {
          caseId: "case-1",
          family: "sparse",
          messages: [],
          acceptedOutput: "accepted reference",
          verdict: "correct",
          note: "",
        },
      ],
    };

    expect(auditTabulate(worksheet).perFamily.sparse).toMatchObject({
      n: 1,
      referenceAgreementPoint: null,
      referenceAgreementPointReason: "below_minimum_audited_count",
    });
  });
});
