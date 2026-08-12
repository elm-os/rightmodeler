import { computeRunSpecDigest, type JsonValue } from "@rightmodeler/core";
import { z } from "zod";

import { buildCorpus } from "./corpus.js";
import type { NormalizedRun } from "./normalized-run.js";

export const MIN_AUDITED_PER_FAMILY = 10;

const verdictSchema = z.enum(["correct", "incorrect", "ambiguous"]);
export type AuditVerdict = z.infer<typeof verdictSchema>;

export interface AuditWorksheetCase {
  caseId: string;
  family: string;
  systemPrompt?: string;
  messages: JsonValue[];
  acceptedOutput: JsonValue;
  verdict: "" | AuditVerdict;
  note: string;
}

export interface AuditWorksheet {
  seed: number;
  populationSize: number;
  cases: AuditWorksheetCase[];
}

export interface FamilyAuditResult {
  n: number;
  disagreement: number;
  wilsonLow: number;
  wilsonHigh: number;
  ceiling: number | null;
  ceilingReason?: "below_minimum_audited_count";
}

export interface AuditResult {
  perFamily: Record<string, FamilyAuditResult>;
}

export class AuditError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditError";
  }
}

function sampleCases(
  cases: ReturnType<typeof buildCorpus>["cases"],
  size: number,
  seed: number,
) {
  return [...cases]
    .sort((left, right) => {
      const leftOrder = computeRunSpecDigest({ seed, caseId: left.caseId });
      const rightOrder = computeRunSpecDigest({ seed, caseId: right.caseId });
      return leftOrder.localeCompare(rightOrder);
    })
    .slice(0, size);
}

export function auditSample(
  runs: readonly NormalizedRun[],
  options: { size: number; seed: number },
): AuditWorksheet {
  try {
    if (!Number.isSafeInteger(options.size) || options.size < 1) {
      throw new AuditError("Audit sample size must be a positive integer");
    }
    const corpus = buildCorpus(runs, { seed: options.seed });
    if (options.size > corpus.cases.length) {
      throw new AuditError(
        `Audit sample size must not exceed ${corpus.cases.length}`,
      );
    }
    const cases = sampleCases(corpus.cases, options.size, options.seed).map(
      ({ caseId, content }) => {
        const worksheetCase: AuditWorksheetCase = {
          caseId,
          family: content.family,
          messages: content.messages,
          acceptedOutput: content.output,
          verdict: "",
          note: "",
        };
        if (content.systemPrompt !== undefined) {
          worksheetCase.systemPrompt = content.systemPrompt;
        }
        return worksheetCase;
      },
    );
    return {
      seed: options.seed,
      populationSize: corpus.cases.length,
      cases,
    };
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError("Audit sampling failed", { cause: error });
  }
}

function wilson(disagreements: number, total: number): [number, number] {
  const z = 1.959963984540054;
  const rate = disagreements / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (rate + zSquared / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * total)) / total)) /
    denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function auditTabulate(worksheet: AuditWorksheet): AuditResult {
  try {
    const families = new Map<string, AuditVerdict[]>();
    for (const worksheetCase of worksheet.cases) {
      const verdict = verdictSchema.parse(worksheetCase.verdict);
      const familyVerdicts = families.get(worksheetCase.family) ?? [];
      familyVerdicts.push(verdict);
      families.set(worksheetCase.family, familyVerdicts);
    }
    if (families.size === 0) {
      throw new AuditError("Audit worksheet contains no cases");
    }

    const perFamily = Object.fromEntries(
      [...families.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([family, verdicts]) => {
          const n = verdicts.length;
          const disagreementCount = verdicts.filter(
            (verdict) => verdict !== "correct",
          ).length;
          const disagreement = disagreementCount / n;
          const [wilsonLow, wilsonHigh] = wilson(disagreementCount, n);
          const result: FamilyAuditResult = {
            n,
            disagreement,
            wilsonLow,
            wilsonHigh,
            ceiling: n >= MIN_AUDITED_PER_FAMILY ? 1 - disagreement : null,
          };
          if (result.ceiling === null) {
            result.ceilingReason = "below_minimum_audited_count";
          }
          return [family, result];
        }),
    );
    return { perFamily };
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError("Audit tabulation failed", { cause: error });
  }
}
