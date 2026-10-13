import type { ComponentType } from "react";

export type PostMeta = {
  slug: string;
  title: string;
  description: string;
  excerpt: string;
  kicker: string;
  /** ISO date, YYYY-MM-DD. Drives the byline and newest-first sort order. */
  date: string;
  readingMinutes: number;
  /** Hero banner: doubles as the OG/Twitter image. 1200x630. */
  hero: { src: string; alt: string };
  author?: string;
};

export type Post = {
  meta: PostMeta;
  Body: ComponentType;
  /** The same post as plain markdown (no front matter). Keep it in sync with Body. */
  markdown: string;
};
