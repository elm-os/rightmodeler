import {
  canonicalJson,
  caseKey,
  casesPrefix,
  computeRunSpecDigest,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import { z } from "zod";

import { normalizedRunSchema, type NormalizedRun } from "./normalized-run.js";

export type CorpusSplit = "shortlist" | "confirm";

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

const corpusOptionsSchema = z.strictObject({
  seed: z.number().int(),
});

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

function assignHalfSplits(cases: CorpusCase[], seed: number): void {
  const byFamily = new Map<string, CorpusCase[]>();
  for (const corpusCase of cases) {
    const familyCases = byFamily.get(corpusCase.content.family) ?? [];
    familyCases.push(corpusCase);
    byFamily.set(corpusCase.content.family, familyCases);
  }

  for (const familyCases of byFamily.values()) {
    familyCases.sort((left, right) => {
      const leftOrder = computeRunSpecDigest({ seed, caseId: left.caseId });
      const rightOrder = computeRunSpecDigest({ seed, caseId: right.caseId });
      return leftOrder.localeCompare(rightOrder);
    });
    const shortlistSize = Math.ceil(familyCases.length / 2);
    familyCases.forEach((corpusCase, index) => {
      corpusCase.split = index < shortlistSize ? "shortlist" : "confirm";
    });
  }
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
    .sort(([left], [right]) => left.localeCompare(right))
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
    const parsedRuns = normalizedRunSchema.array().parse(runs);
    const { seed } = corpusOptionsSchema.parse(options);
    const uniqueCases = new Map<string, CorpusCase>();
    for (const run of parsedRuns) {
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
    assignHalfSplits(cases, seed);
    cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
    const caseIds = cases.map(({ caseId }) => caseId);
    return {
      corpusVersionId: computeRunSpecDigest(caseIds),
      seed,
      cases,
      strata: buildStrata(cases, parsedRuns),
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
    `${casesPrefix(projectId)}corpus-${corpus.corpusVersionId}.json`,
    Buffer.from(canonicalJson(corpusManifest(corpus)), "utf8"),
  );
}
