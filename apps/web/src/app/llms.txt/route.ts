// Serves /llms.txt — the llmstxt.org index of the site for language models. Built from the post
// registry, so it stays in sync as posts are added. No runtime data, so it prerenders as a static
// route under Cache Components (served text/plain per the convention).

import { buildLlmsTxt } from "@/lib/llms";

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
