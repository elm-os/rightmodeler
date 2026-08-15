import { computeRunSpecDigest, type JsonValue } from "@rightmodeler/core";
import { wilson } from "@rightmodeler/kernel";
import { z } from "zod";

import { buildCorpus, type Corpus } from "./corpus.js";
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
  /** Observed agreement point only; the two-sided contamination model is deferred. */
  referenceAgreementPoint: number | null;
  referenceAgreementPointReason?: "below_minimum_audited_count";
}

export interface AuditResult {
  perFamily: Record<string, FamilyAuditResult>;
}

export interface ReferenceCeilingCase {
  readonly family: string;
  readonly referenceSource?: "curated";
  readonly referenceVerified?: boolean;
}

export interface ReferenceCeiling {
  readonly family: string;
  readonly multiplier: number;
  readonly baseMultiplier: number;
  readonly baseSource: "audit" | "default";
  readonly referenceCount: number;
  readonly verifiedCuratedReferences: number;
}

export class AuditError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditError";
  }
}

export function referenceCeilings(
  cases: readonly ReferenceCeilingCase[],
  audit?: AuditResult,
): ReferenceCeiling[] {
  const byFamily = new Map<string, ReferenceCeilingCase[]>();
  for (const item of cases) {
    byFamily.set(item.family, [...(byFamily.get(item.family) ?? []), item]);
  }
  return [...byFamily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, familyCases]) => {
      const audited = audit?.perFamily[family]?.referenceAgreementPoint;
      const baseMultiplier = audited ?? 1;
      const verifiedCuratedReferences = familyCases.filter(
        (item) =>
          item.referenceSource === "curated" && item.referenceVerified === true,
      ).length;
      return {
        family,
        multiplier:
          (verifiedCuratedReferences +
            (familyCases.length - verifiedCuratedReferences) * baseMultiplier) /
          familyCases.length,
        baseMultiplier,
        baseSource:
          audited === undefined || audited === null ? "default" : "audit",
        referenceCount: familyCases.length,
        verifiedCuratedReferences,
      };
    });
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
      return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
    })
    .slice(0, size);
}

export function auditSample(
  runs: readonly NormalizedRun[],
  options: { size: number; seed: number },
): AuditWorksheet {
  try {
    return auditCorpusSample(
      buildCorpus(runs, { seed: options.seed }),
      options,
    );
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError("Audit sampling failed", { cause: error });
  }
}

export function auditCorpusSample(
  corpus: Corpus,
  options: { size: number; seed: number },
): AuditWorksheet {
  try {
    if (!Number.isSafeInteger(options.size) || options.size < 1) {
      throw new AuditError("Audit sample size must be a positive integer");
    }
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
          const { lower: wilsonLow, upper: wilsonHigh } = wilson(
            disagreementCount,
            n,
          );
          const result: FamilyAuditResult = {
            n,
            disagreement,
            wilsonLow,
            wilsonHigh,
            referenceAgreementPoint:
              n >= MIN_AUDITED_PER_FAMILY ? 1 - disagreement : null,
          };
          if (result.referenceAgreementPoint === null) {
            result.referenceAgreementPointReason =
              "below_minimum_audited_count";
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
