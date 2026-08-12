import type { StepRecord } from "@rightmodeler/core";

import type { DetectedLanguage, DetectedTech } from "./detect-tech.js";

export const coveragePolicy = Object.freeze({
  policyVersion: "scanner-coverage-v1",
  lowLanguageMatchRate: 0.01,
  aiDependencyZeroMatchIsFailure: true,
  invoiceReconciliationMinimumShare: null,
} as const);

export type CoverageFailureCode =
  "AI_DEPENDENCY_ZERO_MATCH" | "LOW_LANGUAGE_MATCH_RATE";

export interface CoverageFailure {
  readonly code: CoverageFailureCode;
  readonly language: DetectedLanguage;
  readonly dependencies: readonly string[];
  readonly matchRate: number;
}

export interface CoverageResult {
  readonly pass: boolean;
  readonly failures: readonly CoverageFailure[];
}

function fileLanguage(filePath: string): DetectedLanguage | undefined {
  if (/\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(filePath))
    return "javascript";
  if (/\.py$/.test(filePath)) return "python";
  return undefined;
}

export function evaluateCoverage(input: {
  readonly stepRecords: readonly StepRecord[];
  readonly fileUniverse: readonly string[];
  readonly detectedTech: DetectedTech;
}): CoverageResult {
  const failures: CoverageFailure[] = [];
  const fileUniverse = new Set(input.fileUniverse);
  const dependencyLanguages = new Set(
    input.detectedTech.aiDependencies.map(({ language }) => language),
  );

  for (const language of [...dependencyLanguages].sort()) {
    const dependencies = [
      ...new Set(
        input.detectedTech.aiDependencies
          .filter((dependency) => dependency.language === language)
          .map((dependency) => dependency.name),
      ),
    ].sort();
    const languageFiles = input.fileUniverse.filter(
      (filePath) => fileLanguage(filePath) === language,
    );
    const matchedFiles = new Set(
      input.stepRecords
        .map((record) => record.callSite.path)
        .filter(
          (filePath) =>
            fileUniverse.has(filePath) && fileLanguage(filePath) === language,
        ),
    );
    const matchRate =
      languageFiles.length === 0 ? 0 : matchedFiles.size / languageFiles.length;

    if (
      input.stepRecords.every(
        (record) =>
          !fileUniverse.has(record.callSite.path) ||
          fileLanguage(record.callSite.path) !== language,
      ) &&
      coveragePolicy.aiDependencyZeroMatchIsFailure
    ) {
      failures.push({
        code: "AI_DEPENDENCY_ZERO_MATCH",
        language,
        dependencies,
        matchRate,
      });
    } else if (matchRate < coveragePolicy.lowLanguageMatchRate) {
      failures.push({
        code: "LOW_LANGUAGE_MATCH_RATE",
        language,
        dependencies,
        matchRate,
      });
    }
  }

  return { pass: failures.length === 0, failures };
}
