// The shape every integration page renders from: one JSON file per tool in ./data, typed here and
// collected by the registry (./index) so the /integrations hub and each /integrations/[slug] route
// resolve from one source. Add an integration = add a JSON file + one line in ./index.
//
// The type is deliberately JSON-friendly — plain strings, booleans, arrays, nested objects, and no
// literal unions (a JSON import infers its strings as `string`, which would not assign to a union).
// Allowed values for the string "enums" are documented on each field instead.

export type IntegrationData = {
  /** URL segment: /integrations/<slug>. Also the sitemap + canonical key. */
  slug: string;
  /** Display name, e.g. "LangSmith". Feeds "rightmodeler + <name>", hub rows, and related links. */
  name: string;
  /**
   * How the tool relates to rightmodeler — switches which sections render.
   * One of: "trace-source" (dedicated ingest adapter) | "trace-source-generic" (autodetected,
   * generic adapter) | "replay-engine" (OpenRouter) | "replay-method" (LiteLLM proxy) |
   * "roadmap" (named future integration, e.g. Crucible routing).
   */
  category: string;
  /** Mono kicker under the eyebrow, e.g. "Trace source · dedicated adapter", "Roadmap · Crucible". */
  categoryLabel: string;
  /** <title> (the layout appends "· rightmodeler"). Keyword-rich, ≈45–55 chars; may differ from H1. */
  title: string;
  /** Meta description (~150–160 chars). Doubles as the hub-row description and the llms.txt line. */
  description: string;
  /** The page H1, fixed pattern: "rightmodeler + <Name>". */
  h1: string;
  /** Hero lede — one or two tool-specific sentences under the H1. */
  lede: string;
  /** TL;DR paragraph near the top: the direct answer to the search intent. */
  tldr: string;
  /** "How it works with <name>" — 3–5 steps. `label` is the mono tag, e.g. "01 · Export". */
  steps: { label: string; title: string; body: string }[];
  /**
   * Setup block. The standard install command renders first on every page (from lib/site
   * RUN_COMMAND, so it can never drift); `commands` lists the tool-specific ones after it.
   */
  setup: { intro: string; commands: { comment: string; command: string }[] };
  /**
   * "What rightmodeler reads from <name>" — normalized-field → source-field rows, taken from the
   * skill's trace-format mapping. Empty array hides the section (non-trace categories).
   */
  reads: { field: string; source: string }[];
  /** Autodetection keys shown as mono chips, e.g. "run_type · trace_id · parent_run_id". Empty string hides. */
  detection: string;
  /** 2–4 concrete use cases for the combination. */
  useCases: { title: string; body: string }[];
  /** "The honest part" — limits and what-this-is-not, in complete sentences. At least two. */
  limits: string[];
  /** FAQ, 4–6 items — rendered as the accordion and emitted as FAQPage JSON-LD. */
  faq: { q: string; a: string }[];
  /** 2–3 sibling slugs for the Related row (resolved to names at render time). */
  related: string[];
  /** CTA variant. One of: "github" (live skill install) | "crucible" (waitlist). */
  cta: string;
};
