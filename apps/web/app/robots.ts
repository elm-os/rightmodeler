// Native App Router robots (MetadataRoute.Robots) — allow everything, point crawlers at the sitemap,
// declare the canonical host. Cached at build.

import type { MetadataRoute } from "next";
import { SITE_URL } from "./lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
