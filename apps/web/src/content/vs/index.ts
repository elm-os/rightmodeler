// Comparison registry — the single source of truth for /vs. Each product is one JSON file in
// ./data, validated against ./vs-page.schema.json by scripts/check-vs.test.mjs and typed against
// VsPageData here (a wrong or missing field fails `pnpm check-types`); the hub, the [slug] route,
// the sitemap, and llms.txt all resolve from this list. To add a comparison: create a JSON file
// and add one import + one entry below. Listed in hub display order: rails, graders, routers.

import type { VsPageData } from "@/content/vs/types";
import openrouter from "@/content/vs/data/openrouter.json";
import litellm from "@/content/vs/data/litellm.json";
import vercelAiGateway from "@/content/vs/data/vercel-ai-gateway.json";
import braintrust from "@/content/vs/data/braintrust.json";
import langsmith from "@/content/vs/data/langsmith.json";
import promptfoo from "@/content/vs/data/promptfoo.json";
import notDiamond from "@/content/vs/data/not-diamond.json";
import martian from "@/content/vs/data/martian.json";

const comparisons: VsPageData[] = [
  openrouter,
  litellm,
  vercelAiGateway,
  braintrust,
  langsmith,
  promptfoo,
  notDiamond,
  martian,
];

export function getAllComparisons(): VsPageData[] {
  return comparisons;
}

export function getComparison(slug: string): VsPageData | undefined {
  return comparisons.find((comparison) => comparison.slug === slug);
}

export function getAllSlugs(): string[] {
  return comparisons.map((comparison) => comparison.slug);
}
