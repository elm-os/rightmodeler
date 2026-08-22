import type { NextConfig } from "next";
import { VARY } from "./src/lib/negotiate";

const nextConfig: NextConfig = {
  // Cache Components + Partial Prefetching (Next.js 16.3 "Instant Navigations").
  // Both are opt-in previews that will become defaults in a future major.
  cacheComponents: true,
  partialPrefetching: true,

  // The .md siblings advertised by <link rel="alternate" type="text/markdown">. These serve
  // Markdown regardless of Accept, which is what a crawler that follows rel="alternate" needs,
  // since it may send no Accept header at all.
  //
  // afterFiles, so a real file in public/ could never be shadowed. Handled entirely in the
  // routing layer, so a .md request costs no function invocation. src/proxy.ts skips dotted
  // paths, which is why these land here and not there.
  //
  // Deepest real route is two segments (/use-cases/reduce-llm-costs); the third is headroom.
  // Vary: Accept on every negotiable page.
  //
  // This cannot live in src/proxy.ts. Headers set on a NextResponse.next() do not reach a
  // prerendered HTML response: it is served from the incremental cache with its stored headers.
  // Verified against a production build, including a rewrite-to-self variant, both of which came
  // back without Accept in Vary.
  //
  // Worth knowing: in 16.3.0-preview.5 this block is a no-op under `next start`, which was
  // isolated with a literal single-path rule and no proxy present. It is compiled into
  // routes-manifest.json correctly, and the deployment platform's router applies it from there,
  // so this is the header the HTML representation actually ships with. Re-check it on a preview
  // deployment after any Next upgrade:
  //   curl -sI https://<deployment>/about | grep -i vary
  //
  // The value is the full union rather than just "Accept", so the RSC tokens survive whether the
  // platform appends to this header or replaces it. Duplicate tokens are legal: Vary is a set.
  //
  // Same exclusions as the proxy matcher, so immutable assets never gain a Vary.
  headers: async () => [
    {
      source: "/((?!_next/|_vercel/|api/|.*\\.).*)",
      headers: [{ key: "Vary", value: VARY }],
    },
  ],

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
