import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// A group of their own is redundant for compliant bots, but overrides any "managed" CDN default
// that blocks them. The *-Search and *-User agents keep the site eligible for AI-answer citations.
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

// POST handlers and the Markdown rewrite target: crawlable, they make readiness scanners judge the
// site as an HTTP API. The .md siblings at /<path>.md stay allowed.
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
