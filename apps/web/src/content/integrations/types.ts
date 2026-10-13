// No literal unions on purpose: a JSON import infers its strings as `string`, which would not
// assign to one. Allowed values for the string "enums" are documented on each field instead.

export type IntegrationData = {
  slug: string;
  name: string;
  /** The vendor's official site, linked from the hero and the Markdown twin. Must be https://. */
  website: string;
  /** A file under public/integrations/logos, e.g. "/integrations/logos/langsmith.svg". */
  logo: string;
  /**
   * Picks the hub band. One of: "trace-source" | "trace-source-generic" | "replay-engine" |
   * "replay-method" | "execution-backend" | "evaluator" | "source-control" | "ci-recipe" |
   * "code-context" | "coming-soon". scripts/check-integrations.test.mjs rejects any other value.
   */
  category: string;
  categoryLabel: string;
  /** <title> (the layout appends "· rightmodeler"). Keyword-rich, ≈45–55 chars; may differ from H1. */
  title: string;
  /** Meta description (~150–160 chars). Doubles as the hub-row description and the llms.txt line. */
  description: string;
  /** The page H1, fixed pattern: "rightmodeler + <Name>". */
  h1: string;
  lede: string;
  tldr: string;
  /** "How it works with <name>": 3–5 steps. `label` is the mono tag, e.g. "01 · Export". */
  steps: { label: string; title: string; body: string }[];
  setup: { intro: string; commands: { comment: string; command: string }[] };
  /** Empty array hides the section (non-trace categories). */
  reads: { field: string; source: string }[];
  /** Autodetection keys, e.g. "run_type · trace_id · parent_run_id". Empty string hides. */
  detection: string;
  useCases: { title: string; body: string }[];
  /** "The honest part": limits and what-this-is-not, in complete sentences. At least two. */
  limits: string[];
  faq: { q: string; a: string }[];
  related: string[];
  /** CTA variant. One of: "github" (live skill install) | "crucible" (waitlist). */
  cta: string;
};
