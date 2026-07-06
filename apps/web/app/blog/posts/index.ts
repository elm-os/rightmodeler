// Post registry — the single source of truth for the blog. Each post module exports `meta` + `Body`;
// register it here and both the /blog index and /blog/[slug] route pick it up. To add a post: create
// a sibling module and add one entry below. Sorted newest-first for listings.

import type { Post } from "./types";
import * as whyWeBuiltRightmodeler from "./why-we-built-rightmodeler";

const posts: Post[] = [
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
