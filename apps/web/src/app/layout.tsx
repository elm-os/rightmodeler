import type { Metadata, Viewport } from "next";
import { preload } from "react-dom";
import { Analytics } from "@vercel/analytics/next";
import { fontPreloads } from "@/lib/fonts";
import "./globals.css";

// Public pages must remain fully prerendered, including client navigations.
export const ensureStatic = "navigation";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.rightmodeler.com"),
  title: {
    default: "rightmodeler",
    template: "%s · rightmodeler",
  },
  alternates: {
    // Discovery hints for the plain-text sidecars (also reachable at their well-known root paths).
    types: {
      "text/plain": [
        { url: "/llms.txt", title: "llms.txt" },
        { url: "/humans.txt", title: "humans.txt" },
      ],
    },
  },
  robots: {
    "max-image-preview": "large",
  },
};

// Matches manifest.ts. Width and initial-scale stay with Next's default meta: never pin scale.
export const viewport: Viewport = {
  themeColor: "#fdfcfc",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  for (const href of fontPreloads) {
    preload(href, { as: "font", type: "font/woff2" });
  }
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {/*
          Everything marked data-reveal waits for JavaScript to appear; this shows it without.
          Scoped to [data-reveal]: a blanket transform:none would also stop the CSS marquee.
        */}
        <noscript>
          <style>{`[data-reveal]{opacity:1!important;transform:none!important}`}</style>
        </noscript>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
