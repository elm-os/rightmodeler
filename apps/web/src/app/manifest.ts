import type { MetadataRoute } from "next";

// The icons carry a safe-zone margin, hence maskable. Colors are parchment-white (docs/design.md).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "rightmodeler",
    short_name: "rightmodeler",
    description:
      "Replay real agent traces through cheaper models and measure each candidate against accepted outputs.",
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
