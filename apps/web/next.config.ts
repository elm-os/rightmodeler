import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    agentUpgrade: "latest",
  },

  // Header rules live in vercel.json, the layer the deployment platform honours: see AGENTS.md.

  // The .md siblings. afterFiles so a real file in public/ is never shadowed; here because
  // src/proxy.ts skips dotted paths. Deepest real route is two segments; the third is headroom.
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
