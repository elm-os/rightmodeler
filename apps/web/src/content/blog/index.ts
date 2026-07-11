// Post registry — the single source of truth for the blog. Each post module exports `meta` + `Body`;
// register it here and both the /blog index and /blog/[slug] route pick it up. To add a post: create
// a sibling module and add one entry below. Sorted newest-first for listings.

import type { Post } from "@/content/blog/types";
import * as theBillNobodyCanRead from "@/content/blog/the-bill-nobody-can-read";
import * as theTuesdayProblem from "@/content/blog/the-tuesday-problem";
import * as whyWeBuiltRightmodeler from "@/content/blog/why-we-built-rightmodeler";

// The two vision posts share a date; the stable sort keeps this order (part one above part two).
const posts: Post[] = [
  {
    meta: theBillNobodyCanRead.meta,
    Body: theBillNobodyCanRead.Body,
    markdown: theBillNobodyCanRead.markdown,
  },
  {
    meta: theTuesdayProblem.meta,
    Body: theTuesdayProblem.Body,
    markdown: theTuesdayProblem.markdown,
  },
  {
    meta: whyWeBuiltRightmodeler.meta,
    Body: whyWeBuiltRightmodeler.Body,
    markdown: whyWeBuiltRightmodeler.markdown,
  },
];

export function getAllPosts(): Post[] {
  return [...posts].sort((a, b) => b.meta.date.localeCompare(a.meta.date));
}

export function getPost(slug: string): Post | undefined {
  return posts.find((post) => post.meta.slug === slug);
}

export function getAllSlugs(): string[] {
  return posts.map((post) => post.meta.slug);
}
