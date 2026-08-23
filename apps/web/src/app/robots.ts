// Native App Router robots (MetadataRoute.Robots), served at /robots.txt.
//
// Open posture: rightmodeler is a developer tool that wants to be crawled, indexed, and cited by both
// search engines and AI assistants. Every page is allowed. The two disallowed prefixes are not
// content: /api holds the POST-only form handlers, and /md is the internal target the .md siblings
// and Accept negotiation rewrite to. Neither is a public interface, and leaving them crawlable made
// readiness scanners infer an HTTP API this site does not have. The .md siblings themselves live at
// /<path>.md and stay allowed. Disallow governs crawlers only, so the forms are unaffected. The
// second group explicitly welcomes AI crawlers — redundant for compliant bots (the `*` group already
// allows them) but it documents intent and overrides any "managed" CDN default that blocks them.
// (`Host` is intentionally omitted: it is a deprecated, Yandex-only directive; canonicalization is
// handled by `alternates.canonical` and redirects instead.)

import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Training, AI-search/citation, and user-triggered fetch bots across the major providers. Allowing
// the *-Search and *-User agents is what keeps the site eligible for AI-answer citations.
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "anthropic-ai",
  "Google-Extended",
  "Applebot-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "meta-externalagent",
  "Amazonbot",
  "CCBot",
];

// Route prefixes that serve no content to a reader: form handlers and the Markdown rewrite target.
const NON_CONTENT = ["/api/", "/md/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: NON_CONTENT },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: NON_CONTENT },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
