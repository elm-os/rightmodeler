// Hub copy lives here, shared by each hub page and its Markdown twin so the two cannot drift.
// Comparison and integration rows reuse the annotated-link line format of lib/llms.ts.

import { getAllPosts } from "@/content/blog";
import { getAllIntegrations } from "@/content/integrations";
import { getAllComparisons } from "@/content/vs";
import { CASE_STUDIES } from "@/content/case-studies";
import { SITE_NAME, SITE_URL, formatPostDate } from "@/lib/site";

type Hub = { eyebrow: string; title: string; lede: string };
type HubBand = { title: string; intro: string; categories: string[] };

export const BLOG_HUB: Hub = {
  eyebrow: "The rightmodeler blog",
  title: "Notes on the work in the loop.",
  lede: "How rightmodeler validates swaps to cheaper models on your own traces, what safe has to mean, and what we changed our minds about.",
};

export const VS_HUB: Hub & { bands: HubBand[] } = {
  eyebrow: "Comparisons",
  title: "Different question, different tool.",
  lede: "rightmodeler is a validation framework for model swaps: it replays your own traces on cheaper models, offline, grades each answer against the output you accepted, and opens a draft pull request when a swap clears every gate, for a person to review and merge. Gateways, observability platforms, eval frameworks, routers, spend meters, context layers, model trainers, benchmarks, and coding agents each answer a different question; rightmodeler reads traces from some and replays through others. Each page draws the line.",
  bands: [
    {
      title: "The rails",
      intro:
        "They move your live requests. rightmodeler reads the requests some of them log, replays candidates through others, offline, and hands back evidence and a draft pull request, not a proxy.",
      categories: ["gateway"],
    },
    {
      title: "The observers",
      intro:
        "They trace, evaluate, and improve your agent where it runs. rightmodeler reads the traces most of them keep and validates, step by step, whether a cheaper model holds up.",
      categories: ["observability"],
    },
    {
      title: "The graders",
      intro:
        "They grade outputs with what you assemble: metrics, assertions, datasets, calibrated judges. rightmodeler asks which steps overpay to clear that bar, on the traces you already have.",
      categories: ["evals"],
    },
    {
      title: "The routers",
      intro:
        "They choose a model per request, at runtime. rightmodeler validates one pinned model per step, offline, before a person merges.",
      categories: ["router"],
    },
    {
      title: "The meters",
      intro:
        "They show where AI spend goes, or trim what each call carries. rightmodeler asks whether each step needs the model it pays for.",
      categories: ["spend"],
    },
    {
      title: "The coaches",
      intro:
        "They improve what your agent sees at runtime, with context learned from its past runs. rightmodeler validates which cheaper model each step can call, not what it sees.",
      categories: ["context"],
    },
    {
      title: "The trainers",
      intro:
        "They train a custom model on your data. rightmodeler validates cheaper models you can already call, step by step, against the outputs you accepted.",
      categories: ["training"],
    },
    {
      title: "The scorekeepers",
      intro:
        "They rank models on benchmark test sets, shared or your own. rightmodeler validates cheaper models for the steps in your code, on your own traces, and only a swap that clears every gate becomes a draft pull request you review.",
      categories: ["benchmarks"],
    },
    {
      title: "The engineers",
      intro:
        "They write the code change themselves, from a logged error, a ticket, or a review comment. rightmodeler proposes one kind of change: a cheaper model for a step, validated on your traces first.",
      categories: ["coding"],
    },
  ],
};

export const INTEGRATIONS_HUB: Hub & { bands: HubBand[] } = {
  eyebrow: "Integrations",
  title: "Works with the traces you already have.",
  lede: "Everything the validation loop touches: where your traces come from, where cheaper candidates replay, what grades the replays, and where a swap that clears every gate becomes a draft pull request. No new SDK, and it all runs offline, beside your app, never in your request path.",
  bands: [
    {
      title: "Reads your traces",
      intro: "Autodetected and folded into one per-step schema.",
      categories: ["trace-source", "trace-source-generic"],
    },
    {
      title: "Grades the replays",
      intro:
        "Scorers you already trust grade each replay, in place of the built-in judge.",
      categories: ["evaluator"],
    },
    {
      title: "Runs the candidates",
      intro:
        "Where the candidate calls run, offline. Gateways here are replay endpoints.",
      categories: ["replay-engine", "replay-method", "execution-backend"],
    },
    {
      title: "Opens the pull request",
      intro:
        "Where a swap that clears every gate becomes a draft pull request you review. rightmodeler never merges it for you.",
      categories: ["source-control", "ci-recipe"],
    },
    {
      title: "Maps your code",
      intro:
        "Static context about the code around each swap, shown beside the evidence and never counted as evidence.",
      categories: ["code-context"],
    },
    {
      title: "Coming soon",
      intro:
        "Not built yet. Each page says exactly what exists today and what does not.",
      categories: ["coming-soon"],
    },
  ],
};

export const CASE_STUDY_HUB: Hub = {
  eyebrow: "Case studies",
  title: "Right-sizing, workload by workload.",
  lede: "Two studies of per-workload model assignment. At B:Side, each of 11 AI layers was benchmarked on its own traces: cost and speed are projected, and the pass rate was measured at 100% on a 20-query benchmark against the outputs B:Side had accepted. At iAM360, which upgraded its hardest coaching paths from Terra to Sol, savings are modeled from one representative request, with no measured quality result. The rightmodeler CLI itself validates only swaps to cheaper models, and its pull requests change only model identifiers.",
};

function link(title: string, path: string, description: string): string {
  return `- [${title}](${SITE_URL}${path}): ${description}`;
}

function head(hub: Hub): string[] {
  return [`# ${hub.title}`, "", hub.eyebrow, "", hub.lede];
}

// Mirrors the hub pages: each band lists its entries in registry order, and an empty band is skipped.
function bands<T extends { category: string }>(
  hubBands: HubBand[],
  items: T[],
  line: (item: T) => string,
): string[] {
  return hubBands.flatMap((band) => {
    const entries = items.filter((item) =>
      band.categories.includes(item.category),
    );
    if (entries.length === 0) return [];
    return ["", `## ${band.title}`, "", band.intro, "", ...entries.map(line)];
  });
}

export function renderBlogIndexMarkdown(): string {
  return [
    ...head(BLOG_HUB),
    ...getAllPosts().flatMap(({ meta }) => [
      "",
      `## [${meta.title}](${SITE_URL}/blog/${meta.slug})`,
      "",
      meta.kicker,
      "",
      meta.excerpt,
      "",
      `${formatPostDate(meta.date)} · ${meta.readingMinutes} min read`,
    ]),
  ].join("\n");
}

export function renderVsIndexMarkdown(): string {
  return [
    ...head(VS_HUB),
    ...bands(VS_HUB.bands, getAllComparisons(), (comparison) =>
      link(
        `${SITE_NAME} vs ${comparison.name}`,
        `/vs/${comparison.slug}`,
        comparison.description,
      ),
    ),
  ].join("\n");
}

export function renderIntegrationsIndexMarkdown(): string {
  return [
    ...head(INTEGRATIONS_HUB),
    ...bands(INTEGRATIONS_HUB.bands, getAllIntegrations(), (integration) =>
      link(
        `${SITE_NAME} + ${integration.name}`,
        `/integrations/${integration.slug}`,
        integration.description,
      ),
    ),
  ].join("\n");
}

// Mirrors the card in order (logo company, headline, excerpt, tagline), heading first as head() does for every eyebrow.
export function renderCaseStudyIndexMarkdown(): string {
  return [
    ...head(CASE_STUDY_HUB),
    ...CASE_STUDIES.flatMap((study) => [
      "",
      `## [${study.headline}](${SITE_URL}/case-study/${study.slug})`,
      "",
      study.company,
      "",
      study.excerpt,
      "",
      study.tagline,
    ]),
  ].join("\n");
}
