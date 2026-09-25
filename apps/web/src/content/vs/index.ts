// Comparison registry — the single source of truth for /vs. Each product is one JSON file in
// ./data, validated against ./vs-page.schema.json by scripts/check-vs.test.mjs and typed against
// VsPageData here (a wrong or missing field fails `pnpm check-types`); the hub, the [slug] route,
// the sitemap, and llms.txt all resolve from this list. To add a comparison: create a JSON file
// and add one import + one entry below. Listed in hub display order: rails, observers, graders,
// routers, meters, coaches, trainers, scorekeepers.

import type { VsPageData } from "@/content/vs/types";
import openrouter from "@/content/vs/data/openrouter.json";
import litellm from "@/content/vs/data/litellm.json";
import vercelAiGateway from "@/content/vs/data/vercel-ai-gateway.json";
import helicone from "@/content/vs/data/helicone.json";
import bifrost from "@/content/vs/data/bifrost.json";
import portkey from "@/content/vs/data/portkey.json";
import braintrust from "@/content/vs/data/braintrust.json";
import langsmith from "@/content/vs/data/langsmith.json";
import langfuse from "@/content/vs/data/langfuse.json";
import phoenix from "@/content/vs/data/phoenix.json";
import weave from "@/content/vs/data/weave.json";
import promptfoo from "@/content/vs/data/promptfoo.json";
import modaic from "@/content/vs/data/modaic.json";
import notDiamond from "@/content/vs/data/not-diamond.json";
import martian from "@/content/vs/data/martian.json";
import riften from "@/content/vs/data/riften.json";
import conifer from "@/content/vs/data/conifer.json";
import codag from "@/content/vs/data/codag.json";
import mentlio from "@/content/vs/data/mentlio.json";
import mirrors from "@/content/vs/data/mirrors.json";
import agnostAi from "@/content/vs/data/agnost-ai.json";
import thirdbrainLabs from "@/content/vs/data/thirdbrain-labs.json";
import valsAi from "@/content/vs/data/vals-ai.json";
import openFrontier from "@/content/vs/data/open-frontier.json";
import artificialAnalysis from "@/content/vs/data/artificial-analysis.json";

const comparisons: VsPageData[] = [
  openrouter,
  litellm,
  vercelAiGateway,
  helicone,
  bifrost,
  portkey,
  braintrust,
  langsmith,
  langfuse,
  phoenix,
  weave,
  promptfoo,
  modaic,
  notDiamond,
  martian,
  riften,
  conifer,
  codag,
  mentlio,
  mirrors,
  agnostAi,
  thirdbrainLabs,
  valsAi,
  openFrontier,
  artificialAnalysis,
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
