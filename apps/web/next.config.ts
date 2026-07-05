import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components + Partial Prefetching (Next.js 16.3 "Instant Navigations").
  // Both are opt-in previews that will become defaults in a future major.
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
