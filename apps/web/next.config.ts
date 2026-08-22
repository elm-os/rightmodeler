import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components + Partial Prefetching (Next.js 16.3 "Instant Navigations").
  // Both are opt-in previews that will become defaults in a future major.
  cacheComponents: true,
  partialPrefetching: true,

  // Response headers deliberately do NOT live here. headers() is not applied to prerendered
  // responses in 16.3.0-preview.5: a literal single-path rule with no proxy present was dropped
  // under next start, and the rule reached routes-manifest.json correctly yet production served
  // the page without it. The Vary rule lives in vercel.json instead. See that file, and the note
  // in AGENTS.md, for what the platform does and does not honour.

  // The .md siblings advertised by <link rel="alternate" type="text/markdown">. These serve
  // Markdown regardless of Accept, which is what a crawler that follows rel="alternate" needs,
  // since it may send no Accept header at all.
  //
  // afterFiles, so a real file in public/ could never be shadowed. Handled entirely in the
  // routing layer, so a .md request costs no function invocation. src/proxy.ts skips dotted
  // paths, which is why these land here and not there.
  //
  // Deepest real route is two segments (/use-cases/reduce-llm-costs); the third is headroom.
  rewrites: async () => ({
    beforeFiles: [],
    afterFiles: [
      { source: "/index.md", destination: "/api/markdown" },
      { source: "/:a.md", destination: "/api/markdown/:a" },
      { source: "/:a/:b.md", destination: "/api/markdown/:a/:b" },
      { source: "/:a/:b/:c.md", destination: "/api/markdown/:a/:b/:c" },
    ],
    fallback: [],
  }),
};

export default nextConfig;
