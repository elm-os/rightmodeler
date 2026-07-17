// The shape every blog post module exports: a typed data record (`meta`) plus a `Body` component
// authored with the prose primitives (components/blog/prose.tsx). The registry (./index) collects
// them, so the /blog index and each /blog/[slug] route resolve from one source. Add a post = add a
// file next to this one + one line in ./index.

import type { ComponentType } from "react";

export type PostMeta = {
  /** URL segment: /blog/<slug>. Also the sitemap + canonical key. */
  slug: string;
  /** Headline. Feeds the <h1>, the <title> (via the layout template), and OG/Twitter titles. */
  title: string;
  /** One-sentence summary — the SEO description and OG/Twitter description. */
  description: string;
  /** Card excerpt on the /blog index (can be a touch softer/longer than `description`). */
  excerpt: string;
  /** Short mono kicker above the title (e.g. "Founding story"). */
  kicker: string;
  /** ISO date, YYYY-MM-DD. Drives sitemap lastModified, the byline, and newest-first sort order. */
  date: string;
  /** Whole minutes, rounded. Shown in the byline line. */
  readingMinutes: number;
  /** Hero banner — doubles as the OG/Twitter image. 1200x630. */
  hero: { src: string; alt: string };
  /** Byline; defaults to the house author when omitted. */
  author?: string;
};

export type Post = {
  meta: PostMeta;
  /** The rendered React body, used on the /blog/[slug] page. */
  Body: ComponentType;
  /** The same post as plain markdown (no front matter). Powers llms-context.txt so LLMs get clean,
   *  structured text. Keep it in sync with Body when editing a post. */
  markdown: string;
};
