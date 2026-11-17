export const TRACE_SOURCES = [
  "Claude Code",
  "Codex",
  "LangSmith / LangGraph",
  "OpenAI SDK",
  "Langfuse",
  "Braintrust",
  "Phoenix (OpenInference)",
  "OpenTelemetry GenAI",
  "Vercel AI SDK",
  "Helicone",
  "W&B Weave",
  "Bifrost",
] as const;

export const ILLUSTRATIVE_SCORECARD = {
  label: "Illustrative",
  floor: "0.90",
  lower: "0.62",
  middle: "0.71",
  approved: "0.94",
  alternative: "0.91",
  deterministic: "1.00",
} as const;

// The CLI's real default, not an illustration: DEFAULT_QUALITY_FLOOR in
// harness/packages/rightmodeler/src/pipeline.ts. A policy file can set it above 0.8 and below 1.
export const DEFAULT_QUALITY_FLOOR = "0.85";
