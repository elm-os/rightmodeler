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

export interface CorpusCase {
  caseId: string;
  content: CorpusCaseContent;
  split: CorpusSplit;
}

export interface StratumWeight {
  family: string;
  corpusShare: number;
  trafficShare: number;
}

export interface Corpus {
  corpusVersionId: string;
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
    const caseIds = cases.map(({ caseId }) => caseId);
    return {
      corpusVersionId: computeRunSpecDigest(caseIds),
      seed,
      cases,
      strata: buildStrata(cases, runs),
    };
  } catch (error) {
    if (error instanceof CorpusError) throw error;
    throw new CorpusError("Corpus construction failed", { cause: error });
  }
}

function corpusManifest(corpus: Corpus): JsonValue {
  return {
    corpusVersionId: corpus.corpusVersionId,
    seed: corpus.seed,
    cases: corpus.cases.map(({ caseId, content, split }) => ({
      caseId,
      family: content.family,
      split,
    })),
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
