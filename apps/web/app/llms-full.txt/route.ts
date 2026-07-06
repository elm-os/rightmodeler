// Serves /llms-full.txt — the full text of the site (product overview + every blog post as Markdown)
// in one file, so an LLM can load the whole corpus from a single URL. Built from the post registry;
// no runtime data, so it prerenders as a static route under Cache Components (served text/plain).

import { buildLlmsFull } from "../lib/llms";

export function GET() {
  return new Response(buildLlmsFull(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
