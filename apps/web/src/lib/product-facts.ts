export const TRACE_SOURCES = [
  "Claude Code",
  "Codex",
  "LangSmith / LangGraph",
  "OpenAI SDK",
  "Langfuse",
  "Braintrust",
  "Phoenix (OpenInference)",
  "OpenTelemetry GenAI",
  "Helicone",
  "W&B Weave",
] as const;

export const ILLUSTRATIVE_SCORECARD = {
  label: "Illustrative",
  floor: "0.90",
  lower: "0.62",
  middle: "0.71",
  pending: "0.88",
  approved: "0.94",
  alternative: "0.91",
  shipped: "0.95",
  deterministic: "1.00",
} as const;
