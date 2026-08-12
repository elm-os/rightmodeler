import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  computeStepId,
  stepRecordSchema,
  type StepRecord,
} from "@rightmodeler/core";

import { MatcherRegistry } from "./matcher-registry.js";
import { matchesFilePatterns } from "./path-pattern.js";
import type { CandidateMatch } from "./types.js";

const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  ".venv",
  "build",
  "__pycache__",
]);

function sourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        files.push(join(directory, entry.name));
      }
    }
  };
  visit(rootDir);
  return files.sort();
}

function candidateKey(candidate: CandidateMatch): string {
  return JSON.stringify([
    candidate.slug,
    candidate.normalizedCallShape,
    candidate.enclosingSymbolPath,
  ]);
}

function capabilityRequirements(candidate: CandidateMatch): string[] {
  const requirements: string[] = [];
  if (candidate.needsStructuredOutput) requirements.push("structured_output");
  if (candidate.needsTools) requirements.push("tools");
  return requirements;
}

export function scan(rootDir: string, registry: MatcherRegistry): StepRecord[] {
  const absoluteRoot = resolve(rootDir);
  const projectId = basename(absoluteRoot);
  const records: StepRecord[] = [];

  for (const absolutePath of sourceFiles(absoluteRoot)) {
    const normalizedPath = relative(absoluteRoot, absolutePath)
      .split(sep)
      .join("/");
    const content = readFileSync(absolutePath, "utf8").replaceAll("\r\n", "\n");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const seen = new Set<string>();

    for (const matcher of registry.getAll()) {
      if (!matchesFilePatterns(normalizedPath, matcher.filePatterns)) continue;
      for (const candidate of matcher.match(content, normalizedPath)) {
        const key = candidateKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);

        const stepId = computeStepId({
          projectId,
          normalizedPath,
          enclosingSymbolPath: candidate.enclosingSymbolPath,
          normalizedCallShape: candidate.normalizedCallShape,
        });
        records.push(
          stepRecordSchema.parse({
            stepId,
            callSite: {
              path: normalizedPath,
              line: candidate.line,
              matcherSlug: candidate.slug,
            },
            family: candidate.slug,
            replayMode: "single_shot",
            prefixProvenance: "unknown",
            riskTier: "normal",
            capabilityRequirements: capabilityRequirements(candidate),
            evaluatorLadder: [],
            currentModel: candidate.modelId ?? null,
            observedCostUsd: 0,
            downstreamStepIds: [],
            candidates: [],
            analysisHistory: [],
            status: "pending",
            contentHash,
          }),
        );
      }
    }
  }

  return records.sort(
    (left, right) =>
      left.callSite.path.localeCompare(right.callSite.path) ||
      left.callSite.line - right.callSite.line ||
      left.callSite.matcherSlug.localeCompare(right.callSite.matcherSlug),
  );
}
