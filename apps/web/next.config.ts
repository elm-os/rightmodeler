import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components + Partial Prefetching (Next.js 16.3 "Instant Navigations").
  // Both are opt-in previews that will become defaults in a future major.
  cacheComponents: true,
  partialPrefetching: true,

  // Response header rules live in vercel.json because that is the layer the deployment platform
  // honours. See the response headers section in AGENTS.md for the separately verified local and
  // platform behaviour.

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
      { source: "/index.md", destination: "/md" },
      { source: "/:a.md", destination: "/md/:a" },
      { source: "/:a/:b.md", destination: "/md/:a/:b" },
      { source: "/:a/:b/:c.md", destination: "/md/:a/:b/:c" },
    ],
    fallback: [],
  }),
};

export default nextConfig;
