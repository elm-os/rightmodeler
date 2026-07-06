import type { Metadata, Viewport } from "next";
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

const description =
  "Replay real agent traces through cheaper models, judge each output against what you already shipped, and prove which swaps are safe.";

export const metadata: Metadata = {
  metadataBase: new URL("https://rightmodeler.com"),
  title: "rightmodeler — prove which models you can safely downgrade",
  description,
  openGraph: {
    title: "rightmodeler",
    description,
    url: "https://rightmodeler.com",
    siteName: "rightmodeler",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "rightmodeler",
    description,
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
