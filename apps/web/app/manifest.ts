import type { MetadataRoute } from "next";

// Web app manifest — the Android / installed-PWA counterpart to apple-icon.png. Icons are the
// two-bar mark on a parchment ground (public/icon-{192,512}.png) with a safe-zone margin, declared
// maskable so adaptive launchers can crop them without clipping the mark. Colors track the
// light-only, paper-toned identity in docs/design.md.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "rightmodeler",
    short_name: "rightmodeler",
    description:
      "Replay real agent traces through cheaper models and prove which swaps are safe.",
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
