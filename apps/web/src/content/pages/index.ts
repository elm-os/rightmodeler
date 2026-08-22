// Markdown representations for the one-off pages: the ones that are not members of a templated
// family (/blog, /vs, /integrations) and so have no registry to generate from.
//
// Adding a page: create ./<slug>.ts exporting `markdown`, register it below, and add the route
// to STATIC_MARKDOWN_PATHS in @/lib/markdown-routes. The build fails until all three are done.
//
// Keep each twin faithful to the page it mirrors. scripts/markdown.test.mjs asserts the page's
// title, lede, and every string in its top-level content constants appear here.

import { markdown as home } from "@/content/pages/home";
import { markdown as about } from "@/content/pages/about";
import { markdown as agent } from "@/content/pages/agent";
import { markdown as caseStudyBside } from "@/content/pages/case-study-bside";
import { markdown as caseStudyIam360 } from "@/content/pages/case-study-iam360";
import { markdown as contact } from "@/content/pages/contact";
import { markdown as crucible } from "@/content/pages/crucible";
import { markdown as feedback } from "@/content/pages/feedback";
import { markdown as glossary } from "@/content/pages/glossary";
import { markdown as howItWorks } from "@/content/pages/how-it-works";
import { markdown as manifesto } from "@/content/pages/manifesto";
import { markdown as privacy } from "@/content/pages/privacy";
import { markdown as reduceLlmCosts } from "@/content/pages/reduce-llm-costs";
import { markdown as terms } from "@/content/pages/terms";

export const PAGE_MARKDOWN: Record<string, string> = {
  "/": home,
  "/about": about,
  "/agent": agent,
  "/case-study/bside": caseStudyBside,
  "/case-study/iam360": caseStudyIam360,
  "/contact": contact,
  "/crucible": crucible,
  "/feedback": feedback,
  "/glossary": glossary,
  "/how-it-works": howItWorks,
  "/manifesto": manifesto,
  "/privacy": privacy,
  "/use-cases/reduce-llm-costs": reduceLlmCosts,
  "/terms": terms,
};
