import { createHash, randomUUID } from "node:crypto";

import canonicalize from "canonicalize";

import type { JsonValue } from "./facts.js";

export interface StepIdentityInput {
  projectId: string;
  normalizedPath: string;
  enclosingSymbolPath: JsonValue;
  normalizedCallShape: {
    callee: string;
    argumentKeys: string[];
    enclosing: string;
  };
}

export interface EvidenceQuestionIdentityInput {
  corpusVersionId: string;
  promptRevision: string;
  gatePolicyVersion: string;
  stepFingerprint: string;
  evaluatorPlan: JsonValue;
  replayMode: "single_shot" | "e2e";
}

export function canonicalJson(value: JsonValue): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new TypeError("Value cannot be represented as canonical JSON");
  }
  return serialized;
}

function canonicalDigest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function computeStepId(input: StepIdentityInput): string {
  return canonicalDigest({
    projectId: input.projectId,
    normalizedPath: input.normalizedPath,
    enclosingSymbolPath: input.enclosingSymbolPath,
    normalizedCallShape: input.normalizedCallShape,
  });
}

export function computeEvidenceQuestionId(
  input: EvidenceQuestionIdentityInput,
): string {
  return canonicalDigest({
    corpusVersionId: input.corpusVersionId,
    promptRevision: input.promptRevision,
    gatePolicyVersion: input.gatePolicyVersion,
    stepFingerprint: input.stepFingerprint,
    evaluatorPlan: input.evaluatorPlan,
    replayMode: input.replayMode,
  });
}

export function computeRunSpecDigest(spec: JsonValue): string {
  return canonicalDigest(spec);
}

export function mintExecutionId(): string {
  return randomUUID();
}

export function mintAttemptId(): string {
  return randomUUID();
}

export function mintAssessmentId(): string {
  return randomUUID();
}
