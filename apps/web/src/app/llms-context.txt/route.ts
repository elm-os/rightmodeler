// Serves /llms-context.txt: a curated product overview, annotated page and integration index, and
// the complete blog archive in one Markdown file. Built from the post and integration registries;
// no runtime data, so it prerenders as a static text/plain route under Cache Components.

import { buildLlmsContext } from "@/lib/llms";

export function GET() {
  return new Response(buildLlmsContext(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
