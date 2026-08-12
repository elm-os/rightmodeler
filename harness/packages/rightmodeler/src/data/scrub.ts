import type { JsonValue } from "@rightmodeler/core";

import { normalizedRunSchema, type NormalizedRun } from "./normalized-run.js";

export type RedactionKind = "email" | "phone";

export interface Redaction {
  runIndex: number;
  stepIndex: number;
  kind: RedactionKind;
}

export interface ScrubResult {
  runs: NormalizedRun[];
  redactions: Redaction[];
}

export class ScrubError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScrubError";
  }
}

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern =
  /(?<![\w])(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?![\w])/g;

function scrubText(
  text: string,
  onRedaction: (kind: RedactionKind) => void,
): string {
  const withoutEmails = text.replace(emailPattern, () => {
    onRedaction("email");
    return "[REDACTED:email]";
  });
  return withoutEmails.replace(phonePattern, () => {
    onRedaction("phone");
    return "[REDACTED:phone]";
  });
}

function scrubJson(
  value: JsonValue,
  onRedaction: (kind: RedactionKind) => void,
): JsonValue {
  if (typeof value === "string") return scrubText(value, onRedaction);
  if (Array.isArray(value)) {
    return value.map((item) => scrubJson(item, onRedaction));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        scrubJson(item, onRedaction),
      ]),
    );
  }
  return value;
}

export function scrubRuns(runs: readonly NormalizedRun[]): ScrubResult {
  try {
    const parsedRuns = normalizedRunSchema.array().parse(runs);
    const redactions: Redaction[] = [];
    const scrubbedRuns = parsedRuns.map((run, runIndex) => ({
      ...run,
      steps: run.steps.map((step) => {
        const kinds = new Set<RedactionKind>();
        const onRedaction = (kind: RedactionKind) => kinds.add(kind);
        const scrubbed = {
          ...step,
          messages: step.messages.map((message) =>
            scrubJson(message, onRedaction),
          ),
          output: scrubJson(step.output, onRedaction),
        };
        if (step.systemPrompt !== undefined) {
          scrubbed.systemPrompt = scrubText(step.systemPrompt, onRedaction);
        }
        for (const kind of kinds) {
          redactions.push({ runIndex, stepIndex: step.stepIndex, kind });
        }
        return scrubbed;
      }),
    }));

    return { runs: scrubbedRuns, redactions };
  } catch (error) {
    if (error instanceof ScrubError) throw error;
    throw new ScrubError("Scrubbing failed; no runs were returned", {
      cause: error,
    });
  }
}
