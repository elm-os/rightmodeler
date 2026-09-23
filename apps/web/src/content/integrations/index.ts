// Integration registry — the single source of truth for /integrations. Each tool is one JSON file
// in ./data, typed against IntegrationData here (a wrong or missing field fails `pnpm check-types`);
// the hub, the [slug] route, the sitemap, and llms.txt all resolve from this list. To add an
// integration: create a JSON file and add one import + one entry below. Listed in hub display
// order: trace sources first, then evaluators, replay infrastructure, source control and CI, code
// context, then coming soon.

import type { IntegrationData } from "@/content/integrations/types";
import langsmith from "@/content/integrations/data/langsmith.json";
import langfuse from "@/content/integrations/data/langfuse.json";
import braintrust from "@/content/integrations/data/braintrust.json";
import phoenix from "@/content/integrations/data/phoenix.json";
import openaiSdk from "@/content/integrations/data/openai-sdk.json";
import claudeCode from "@/content/integrations/data/claude-code.json";
import codex from "@/content/integrations/data/codex.json";
import otel from "@/content/integrations/data/otel.json";
import helicone from "@/content/integrations/data/helicone.json";
import weave from "@/content/integrations/data/weave.json";
import openrouter from "@/content/integrations/data/openrouter.json";
import litellm from "@/content/integrations/data/litellm.json";
import vercelAiGateway from "@/content/integrations/data/vercel-ai-gateway.json";
import vercelAiSdk from "@/content/integrations/data/vercel-ai-sdk.json";
import promptfoo from "@/content/integrations/data/promptfoo.json";
import vercelSandbox from "@/content/integrations/data/vercel-sandbox.json";
import github from "@/content/integrations/data/github.json";
import githubActions from "@/content/integrations/data/github-actions.json";
import graphify from "@/content/integrations/data/graphify.json";
import modaic from "@/content/integrations/data/modaic.json";

const integrations: IntegrationData[] = [
  claudeCode,
  codex,
  langsmith,
  openaiSdk,
  langfuse,
  braintrust,
  phoenix,
  otel,
  vercelAiSdk,
  helicone,
  weave,
  promptfoo,
  openrouter,
  litellm,
  vercelAiGateway,
  vercelSandbox,
  github,
  githubActions,
  graphify,
  modaic,
];

export function getAllIntegrations(): IntegrationData[] {
  return integrations;
}

export function getIntegration(slug: string): IntegrationData | undefined {
  return integrations.find((integration) => integration.slug === slug);
}

export function getAllSlugs(): string[] {
  return integrations.map((integration) => integration.slug);
}
