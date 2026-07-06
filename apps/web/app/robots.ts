// Native App Router robots (MetadataRoute.Robots), served at /robots.txt.
//
// Open posture: rightmodeler is a developer tool that wants to be crawled, indexed, and cited by both
// search engines and AI assistants. Nothing on the site is private, so everything is allowed. The
// second group explicitly welcomes AI crawlers — redundant for compliant bots (the `*` group already
// allows them) but it documents intent and overrides any "managed" CDN default that blocks them.
// (`Host` is intentionally omitted: it is a deprecated, Yandex-only directive; canonicalization is
// handled by `alternates.canonical` and redirects instead.)

import type { MetadataRoute } from "next";
import { SITE_URL } from "./lib/site";

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

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      { userAgent: AI_CRAWLERS, allow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
