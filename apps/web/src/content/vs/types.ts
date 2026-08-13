// The shape every comparison page renders from: one JSON file per product in ./data, typed here
// and collected by the registry (./index) so the /vs hub and each /vs/[slug] route resolve from
// one source. Add a comparison = add a JSON file + one line in ./index.
//
// The type is deliberately JSON-friendly: plain strings, arrays, nested objects, and no literal
// unions (a JSON import infers its strings as `string`, which would not assign to a union).
// Allowed values for the string "enums" are documented on each field instead; the real contract is
// ./vs-page.schema.json, enforced on every data file by scripts/check-vs.test.mjs in `pnpm check`.

/** One side of a two-column block: a heading over plain-text rows. */
export type VsSide = { heading: string; items: string[] };

/**
 * One content band. `type` selects the rendering in app/vs/[slug] and decides which of the
 * optional fields below apply; the schema requires exactly the fields each type needs, so the
 * renderer never meets a half-filled block.
 * One of: "tldr" | "positioning" | "contrast" | "fork" | "scenarios" | "table" | "stack" |
 * "prose" | "definitions" | "faq".
 */
export type VsBlock = {
  type: string;
  /** tldr: the one-paragraph answer to the search intent. */
  body?: string;
  /** Band heading (scenarios, table, stack, prose, definitions). */
  heading?: string;
  /** Optional left-rail intro under the band heading. */
  intro?: string;
  /** positioning | contrast | fork: the two columns; rightmodeler is always the right one. */
  left?: VsSide;
  right?: VsSide;
  /**
   * scenarios: 2-3 concrete situations, each naming the right tool honestly.
   * `winner` is "theirs" | "ours" | "both"; at least one "theirs" per block (build-enforced).
   */
  scenarios?: { scenario: string; winner: string; why: string }[];
  /** table: optional mono caption bar, e.g. "openrouter vs rightmodeler". */
  caption?: string;
  /** table: column header labels. */
  leftLabel?: string;
  rightLabel?: string;
  /** table rows: one dimension compared side by side. */
  rows?: { dimension: string; theirs: string; ours: string }[];
  /** stack | prose: paragraphs in reading order. */
  paragraphs?: string[];
  /** stack: copyable commands, a mono comment over each. */
  commands?: { comment: string; command: string }[];
  /** definitions: terms; `slug` (optional) links to /glossary#<slug> and must be a real anchor. */
  terms?: { term: string; def: string; slug?: string }[];
  /** faq: visible accordion items. */
  items?: { q: string; a: string }[];
};

export type VsPageData = {
  /** URL segment: /vs/<slug>. Also the sitemap + canonical key; equals the data file's basename. */
  slug: string;
  /** Display name, e.g. "OpenRouter". Feeds "rightmodeler vs <name>", hub cards, related links. */
  name: string;
  /**
   * Which hub band the page belongs to; presentation only.
   * One of: "gateway" (The rails) | "evals" (The graders) | "router" (The routers).
   */
  category: string;
  /**
   * The page's one-word answer to "competitor or complement".
   * One of: "complement" | "competitor" | "different-job".
   */
  verdict: string;
  /** Hero chip spelling the verdict out, e.g. "Complement · rightmodeler runs on top". */
  verdictLabel: string;
  /** <title> (the layout appends "· rightmodeler"): "rightmodeler vs <Name>: <differentiator>". */
  title: string;
  /** Meta description (~150-160 chars). Doubles as the hub-card line and the llms.txt line. */
  description: string;
  /** The page H1, fixed pattern: "rightmodeler vs <Name>". */
  h1: string;
  /** Hero lede: one or two sentences drawing the line between the two tools. */
  lede: string;
  /** Matching /integrations/<slug> when one exists; empty string hides the cross-link. */
  integrationSlug: string;
  /** 2-3 sibling comparison slugs for the Related row (resolved at render; missing slugs drop). */
  related: string[];
  /** CTA variant. One of: "github" (live skill install) | "crucible" (waitlist). */
  cta: string;
  /** Content bands in render order; every block type is optional and repeatable. */
  blocks: VsBlock[];
};
