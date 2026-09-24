import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  computeStepId,
  stepRecordSchema,
  type StepRecord,
} from "@rightmodeler/core";

import { IGNORED_DIRECTORIES } from "./ignored-directories.js";
import { MatcherRegistry } from "./matcher-registry.js";
import { maskSource } from "./matchers/utils.js";
import { matchesFilePatterns } from "./path-pattern.js";
import type { CandidateMatch } from "./types.js";

export interface ScanSkip {
  readonly path: string;
  readonly matcherSlug?: string;
  readonly reason: string;
}

export interface ScanResult {
  readonly records: StepRecord[];
  readonly skipped: ScanSkip[];
}

function sourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name))
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scanRepository(
  rootDir: string,
  registry: MatcherRegistry,
  projectId: string,
): ScanResult {
  const absoluteRoot = resolve(rootDir);
  const records: StepRecord[] = [];
  const skipped: ScanSkip[] = [];
  const matchers = registry.getAll();

  for (const absolutePath of sourceFiles(absoluteRoot)) {
    const normalizedPath = relative(absoluteRoot, absolutePath)
      .split(sep)
      .join("/");
    const fileMatchers = matchers.filter((matcher) =>
      matchesFilePatterns(normalizedPath, matcher.filePatterns),
    );
    if (fileMatchers.length === 0) continue;
    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8").replaceAll("\r\n", "\n");
    } catch (error) {
      skipped.push({ path: normalizedPath, reason: message(error) });
      continue;
    }
    const searchable = maskSource(content, normalizedPath);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const seen = new Set<string>();

    for (const matcher of fileMatchers) {
      let candidates: CandidateMatch[];
      try {
        candidates = matcher.match(content, normalizedPath, searchable);
      } catch (error) {
        skipped.push({
          path: normalizedPath,
          matcherSlug: matcher.slug,
          reason: message(error),
        });
        continue;
      }
      for (const candidate of candidates) {
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
            ...(candidate.traceKey === undefined
              ? {}
              : { traceKey: candidate.traceKey }),
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

  return {
    records: records.sort(
      (left, right) =>
        left.callSite.path.localeCompare(right.callSite.path) ||
        left.callSite.line - right.callSite.line ||
        left.callSite.matcherSlug.localeCompare(right.callSite.matcherSlug),
    ),
    skipped,
  };
}

export function scan(
  rootDir: string,
  registry: MatcherRegistry,
  projectId: string,
): StepRecord[] {
  return scanRepository(rootDir, registry, projectId).records;
}
