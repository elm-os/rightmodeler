import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Inter, DM_Sans, Space_Grotesk, Geist_Mono } from "next/font/google";
import "./globals.css";

// Public pages must remain fully prerendered, including client navigations.
export const ensureStatic = "navigation";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Free substitute for the licensed "Waldenburg".
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

// Free substitute for the licensed "WaldenburgFH".
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
  return (
    <html
      lang="en"
      className={`${inter.variable} ${dmSans.variable} ${spaceGrotesk.variable} ${geistMono.variable} h-full antialiased`}
    >
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
