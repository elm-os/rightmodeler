import {
  canonicalJson,
  caseKey,
  computeRunSpecDigest,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import { assignSplits, type CorpusSplit } from "@rightmodeler/kernel";

import type { NormalizedRun } from "./normalized-run.js";

export interface CorpusCaseContent {
  family: string;
  model: string;
  systemPrompt?: string;
  messages: JsonValue[];
  output: JsonValue;
  trajectoryId: string;
  stepIndex: number;
}

export interface CorpusCaseObservation {
  traceId?: string;
  usage: { inputTokens: number; outputTokens: number };
  timestamp?: string;
  costUsd?: number;
  durationMs?: number;
  toolCalls: JsonValue[];
  evaluator?: JsonValue;
  evaluatorVersion?: JsonValue;
  retryCount?: number;
}

export interface CorpusCase {
  caseId: string;
  content: CorpusCaseContent;
  split: CorpusSplit;
  observation?: CorpusCaseObservation;
}

export interface StratumWeight {
  family: string;
  corpusShare: number;
  trafficShare: number;
}

export interface Corpus {
  corpusVersionId: string;
  contractVersion?: number;
  seed: number;
  cases: CorpusCase[];
  strata: StratumWeight[];
}

export class CorpusError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorpusError";
  }
}

function familyOf(family: string | undefined): string {
  return family ?? "unclassified";
}

function caseContent(step: NormalizedRun["steps"][number]): CorpusCaseContent {
  const content: CorpusCaseContent = {
    family: familyOf(step.family),
    model: step.model,
    messages: step.messages,
    output: step.output,
    trajectoryId: step.trajectoryId,
    stepIndex: step.stepIndex,
  };
  if (step.systemPrompt !== undefined) {
    content.systemPrompt = step.systemPrompt;
  }
  return content;
}

function toolCalls(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value.flatMap(toolCalls);
  if (typeof value !== "object" || value === null) return [];
  const direct = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(direct)) return direct;
  return Object.values(value).flatMap(toolCalls);
}

function caseObservation(
  step: NormalizedRun["steps"][number],
  traceId: string,
): CorpusCaseObservation {
  return {
    traceId,
    usage: { ...step.usage },
    toolCalls: toolCalls(step.output),
    ...(step.timestamp === undefined ? {} : { timestamp: step.timestamp }),
    ...(step.costUsd === undefined ? {} : { costUsd: step.costUsd }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
    ...(step.evaluator === undefined ? {} : { evaluator: step.evaluator }),
    ...(step.evaluatorVersion === undefined
      ? {}
      : { evaluatorVersion: step.evaluatorVersion }),
    ...(step.retryCount === undefined ? {} : { retryCount: step.retryCount }),
  };
}

function caseContentJson(content: CorpusCaseContent): JsonValue {
  const value: Record<string, JsonValue> = {
    family: content.family,
    model: content.model,
    messages: content.messages,
    output: content.output,
    trajectoryId: content.trajectoryId,
    stepIndex: content.stepIndex,
  };
  if (content.systemPrompt !== undefined) {
    value.systemPrompt = content.systemPrompt;
  }
  return value;
}

function caseObservationJson(observation: CorpusCaseObservation): JsonValue {
  return {
    ...(observation.traceId === undefined
      ? {}
      : { traceId: observation.traceId }),
    usage: { ...observation.usage },
    toolCalls: [...observation.toolCalls],
    ...(observation.timestamp === undefined
      ? {}
      : { timestamp: observation.timestamp }),
    ...(observation.costUsd === undefined
      ? {}
      : { costUsd: observation.costUsd }),
    ...(observation.durationMs === undefined
      ? {}
      : { durationMs: observation.durationMs }),
    ...(observation.evaluator === undefined
      ? {}
      : { evaluator: observation.evaluator }),
    ...(observation.evaluatorVersion === undefined
      ? {}
      : { evaluatorVersion: observation.evaluatorVersion }),
    ...(observation.retryCount === undefined
      ? {}
      : { retryCount: observation.retryCount }),
  };
}

function corpusIndexCases(corpus: Corpus): JsonValue[] {
  return corpus.cases.map(({ caseId, content, split, observation }) => ({
    caseId,
    family: content.family,
    split,
    ...(observation === undefined
      ? {}
      : { observation: caseObservationJson(observation) }),
  }));
}

export function refreshCorpusVersionId(corpus: Corpus): void {
  corpus.corpusVersionId = computeRunSpecDigest({
    seed: corpus.seed,
    cases: corpusIndexCases(corpus),
    strata: corpus.strata.map((weight) => ({ ...weight })),
  });
}

function buildStrata(
  cases: readonly CorpusCase[],
  runs: readonly NormalizedRun[],
): StratumWeight[] {
  const caseCounts = new Map<string, number>();
  for (const corpusCase of cases) {
    const family = corpusCase.content.family;
    caseCounts.set(family, (caseCounts.get(family) ?? 0) + 1);
  }

  const trafficCounts = new Map<string, number>();
  for (const run of runs) {
    const runFamilies = new Set(run.steps.map((step) => familyOf(step.family)));
    for (const family of runFamilies) {
      trafficCounts.set(family, (trafficCounts.get(family) ?? 0) + 1);
    }
  }
  const totalTraffic = [...trafficCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );

  return [...caseCounts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([family, count]) => ({
      family,
      corpusShare: count / cases.length,
      trafficShare: (trafficCounts.get(family) ?? 0) / totalTraffic,
    }));
}

export function buildCorpus(
  runs: readonly NormalizedRun[],
  options: { seed: number },
): Corpus {
  try {
    const { seed } = options;
    const uniqueCases = new Map<string, CorpusCase>();
    for (const run of runs) {
      for (const step of run.steps) {
        const content = caseContent(step);
        const caseId = computeRunSpecDigest(caseContentJson(content));
        uniqueCases.set(caseId, {
          caseId,
          content,
          split: "shortlist",
          observation: caseObservation(step, run.traceId),
        });
      }
    }
    if (uniqueCases.size === 0) {
      throw new CorpusError("Cannot build a corpus without normalized steps");
    }

    const cases = [...uniqueCases.values()];
    const splits = assignSplits(
      cases.map(({ caseId }) => caseId),
      seed,
    );
    for (const corpusCase of cases) {
      corpusCase.split = splits[corpusCase.caseId]!;
    }
    cases.sort((left, right) => compareText(left.caseId, right.caseId));
    const corpus: Corpus = {
      corpusVersionId: "",
      contractVersion: 1,
      seed,
      cases,
      strata: buildStrata(cases, runs),
    };
    refreshCorpusVersionId(corpus);
    return corpus;
  } catch (error) {
    if (error instanceof CorpusError) throw error;
    throw new CorpusError("Corpus construction failed", { cause: error });
  }
}

function corpusManifest(corpus: Corpus): JsonValue {
  return {
    corpusVersionId: corpus.corpusVersionId,
    contractVersion: corpus.contractVersion ?? 1,
    seed: corpus.seed,
    cases: corpusIndexCases(corpus),
    strata: corpus.strata.map((weight) => ({ ...weight })),
  };
}

export async function writeCorpus(
  store: Store,
  projectId: string,
  corpus: Corpus,
): Promise<void> {
  for (const corpusCase of corpus.cases) {
    await store.putImmutable(
      caseKey(projectId, corpusCase.caseId),
      Buffer.from(canonicalJson(caseContentJson(corpusCase.content)), "utf8"),
    );
  }
  await store.putImmutable(
    // Internal Phase A corpus index; not a public contract.
    `${projectId}/corpus/corpus-${corpus.corpusVersionId}.json`,
    Buffer.from(canonicalJson(corpusManifest(corpus)), "utf8"),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
