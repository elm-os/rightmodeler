// Open Graph card for every integration page, generated from the registry at build time. The
// twitter card inherits it (see pageMetadata's `image: null` in @/lib/seo), so a new integration
// needs no hand-made image.
//
// Layout and colors reproduce the original hand-made cards; tokens are from docs/design.md. Type is
// the site's own faces: the display face for the title, the wordmark face for the lockup, and the
// UI face for the eyebrow and the tagline. ImageResponse only reads ttf/otf/woff and renders a
// variable font at its default instance, so src/assets/og holds static instances of the exact
// weights, subset to the same latin range next/font loads (licence: OFL.txt beside them).
// The right-hand panel (glow, dot grid, trace illustration) is identical on every card and is
// embedded as the original raster, since its layered blurred glow has no ImageResponse equivalent.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { ImageResponse } from "next/og";
import { getAllSlugs, getIntegration } from "@/content/integrations";

export const alt = "rightmodeler integration social preview";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Prerender one card per integration, the same params the page itself prerenders.
export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

// docs/design.md tokens.
const PARCHMENT_WHITE = "#fdfcfc";
const ASH_BORDER = "#e5e5e5";
const MIDNIGHT_INK = "#000000";
const DRIFTWOOD = "#777169";

const ASSETS = join(process.cwd(), "src/assets/og");
const [displayFont, uiFont, wordmarkFont, panel] = await Promise.all([
  readFile(join(ASSETS, "DMSans-Light.ttf")),
  readFile(join(ASSETS, "Inter-Regular.ttf")),
  readFile(join(ASSETS, "SpaceGrotesk-Bold.ttf")),
  readFile(join(ASSETS, "integration-panel.png"), "base64"),
]);
const panelSrc = `data:image/png;base64,${panel}`;

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) notFound();
  // At 95px a name longer than about 20 characters, such as "Agent Router (formerly Envoy AI
  // Gateway)", wraps to three lines and runs into the tagline; 72px fits three above it.
  const longName = integration.name.length > 20;

  return new ImageResponse(
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: PARCHMENT_WHITE,
        color: MIDNIGHT_INK,
      }}
    >
      <img
        src={panelSrc}
        alt=""
        width={454}
        height={626}
        style={{ position: "absolute", left: 744, top: 2 }}
      />

      {/* Brand lockup: the two-bar mark as drawn on the original cards, then the wordmark. */}
      <svg
        width={39.3}
        height={44}
        viewBox="0 0 39.3 44"
        fill={MIDNIGHT_INK}
        style={{ position: "absolute", left: 72, top: 64 }}
      >
        <rect x={0} y={0} width={18} height={44} />
        <rect x={22} y={15.4} width={17.3} height={28.6} />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 129,
          top: 77,
          fontFamily: "Space Grotesk",
          fontWeight: 700,
          fontSize: 24.5,
          lineHeight: 1,
          letterSpacing: "0.045em",
        }}
      >
        rightmodeler
      </div>

      <div
        style={{
          position: "absolute",
          left: 72,
          top: 143,
          width: 672,
          height: 1,
          backgroundColor: ASH_BORDER,
          // The originals sit this hairline on a half pixel; Satori rounds a fractional top, but
          // not a transform.
          transform: "translateY(0.5px)",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 72,
          top: 191,
          fontFamily: "Inter",
          fontSize: 15,
          lineHeight: 1,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: DRIFTWOOD,
        }}
      >
        Integration
      </div>

      {/* The page H1 ("rightmodeler + <name>"), broken after the plus as on the originals. */}
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 204,
          width: 672,
          display: "flex",
          flexDirection: "column",
          fontFamily: "DM Sans",
          fontWeight: 300,
          fontSize: longName ? 72 : 95,
          lineHeight: longName ? "74px" : "98px",
          letterSpacing: "-0.0375em",
        }}
      >
        <div>rightmodeler +</div>
        <div>{integration.name}</div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 72,
          top: 541,
          fontFamily: "Inter",
          fontSize: 15,
          lineHeight: 1,
          letterSpacing: "0.01em",
          color: DRIFTWOOD,
        }}
      >
        Evidence before model changes.
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          border: `2px solid ${ASH_BORDER}`,
        }}
      />
    </div>,
    {
      ...size,
      fonts: [
        { name: "DM Sans", data: displayFont, weight: 300, style: "normal" },
        { name: "Inter", data: uiFont, weight: 400, style: "normal" },
        {
          name: "Space Grotesk",
          data: wordmarkFont,
          weight: 700,
          style: "normal",
        },
      ],
    },
  );
}
