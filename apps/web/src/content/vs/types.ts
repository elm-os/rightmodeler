// No literal unions on purpose: a JSON import infers its strings as `string`, which would not
// assign to one. The real contract is ./vs-page.schema.json, enforced by scripts/check-vs.test.mjs.

export type VsSide = { heading: string; items: string[] };

/** `type` picks the renderer in app/vs/[slug]; the schema requires exactly the fields it needs. */
export type VsBlock = {
  type: string;
  body?: string;
  heading?: string;
  intro?: string;
  /** positioning | contrast | fork: the two columns; rightmodeler is always the right one. */
  left?: VsSide;
  right?: VsSide;
  /** `winner` is "theirs" | "ours" | "both"; at least one "theirs" per block (build-enforced). */
  scenarios?: { scenario: string; winner: string; why: string }[];
  caption?: string;
  leftLabel?: string;
  rightLabel?: string;
  rows?: { dimension: string; theirs: string; ours: string }[];
  paragraphs?: string[];
  commands?: { comment: string; command: string }[];
  /** definitions: terms; `slug` (optional) links to /glossary#<slug> and must be a real anchor. */
  terms?: { term: string; def: string; slug?: string }[];
  items?: { q: string; a: string }[];
};

export type VsPageData = {
  /** URL segment: /vs/<slug>. Also the sitemap + canonical key; equals the data file's basename. */
  slug: string;
  name: string;
  website: string;
  /** Reuse the integration's mark (public/integrations/logos) when one exists. */
  logo: string;
  category: string;
  verdict: string;
  verdictLabel: string;
  /** <title> (the layout appends "· rightmodeler"): "rightmodeler vs <Name>: <differentiator>". */
  title: string;
  /** Meta description (~150-160 chars). Doubles as the hub-card line and the llms.txt line. */
  description: string;
  h1: string;
  lede: string;
  /** Matching /integrations/<slug> when one exists; empty string hides the cross-link. */
  integrationSlug: string;
  related: string[];
  cta: string;
  blocks: VsBlock[];
};
