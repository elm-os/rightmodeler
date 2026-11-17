import type { MetadataRoute } from "next";

// The icons carry a safe-zone margin, hence maskable. Colors are parchment-white (docs/design.md).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "rightmodeler",
    short_name: "rightmodeler",
    description:
      "Cheaper model swaps for production AI, validated on your own traces and opened as draft PRs.",
    start_url: "/",
    display: "standalone",
    background_color: "#fdfcfc",
    theme_color: "#fdfcfc",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
