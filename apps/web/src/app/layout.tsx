import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Inter, DM_Sans, Space_Grotesk, Geist_Mono } from "next/font/google";
import "./globals.css";

// Functional / UI face — nav, buttons, body copy, labels, inputs, captions.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Display face — free substitute for the licensed "Waldenburg" (headlines, 300).
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

// Wordmark face — free substitute for the licensed "WaldenburgFH" (logo, 700).
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

// Monospace — code snippets, API references, technical labels.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.rightmodeler.com"),
  title: {
    default: "rightmodeler",
    // Child pages set a short title; this appends the brand (e.g. "Blog · rightmodeler").
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

// Tint the mobile browser chrome (Chrome Android address bar, Safari iOS toolbar) to the
// parchment canvas so it blends with the page top. parchment-white — matches manifest.ts.
// (Width/initial-scale are intentionally left to Next's default meta; never pin scale.)
export const viewport: Viewport = {
  themeColor: "#fdfcfc",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${dmSans.variable} ${spaceGrotesk.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          Reveal and the hero ledger enter with motion's whileInView, which needs JavaScript, so
          they server-render at opacity:0. Without this rule a reader or crawler with JS off sees
          a blank page: the h1, the lede, every section heading, and the whole ledger stay
          invisible. An !important author rule outranks the inline non-important declaration.
          Scoped to [data-reveal] on purpose: a blanket transform:none would also stop the
          trace-source marquee, which is pure CSS and should keep running without JS.
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
