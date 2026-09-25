// Long-form article typography, built from the semantic type tokens (docs/design.md) rather than a
// `prose`/typography plugin — the plugin would hand-set leading/tracking, which the design system
// forbids. Compose a post Body from these blocks; <Prose> sets the reading measure + vertical rhythm.
//
// Motion (Emil bar): running paragraphs stay static — you read them in a continuous scroll, so an
// entrance on each would be the "animate something seen constantly" mistake. Only the deliberate
// beats (section headings, pull quotes, figures) reveal once as they enter. All monochrome: ink
// headings, driftwood body, fog captions; accent hues never appear in text.

import type { ReactNode } from "react";
import { Reveal } from "@/components/reveal";

// One reading column, ~42rem, with a steady 24px rhythm between blocks. Headings and quotes add their
// own extra breathing room on top of the rhythm via padding, so the gap above them reads as a break.
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 sm:px-8">{children}</div>
  );
}

// The opening paragraph — one size up, sets the tone.
export function Lead({ children }: { children: ReactNode }) {
  return <p className="text-subheading text-driftwood">{children}</p>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-body text-driftwood">{children}</p>;
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <Reveal className="pt-6">
      <h2 className="font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
        {children}
      </h2>
    </Reveal>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return (
    <h3 className="pt-2 font-display text-heading-sm text-midnight-ink">
      {children}
    </h3>
  );
}

// A single emphasised line lifted out of the body — ink on an ash-border rule, display face.
export function PullQuote({ children }: { children: ReactNode }) {
  return (
    <Reveal className="py-2">
      <blockquote className="border-l border-ash-border pl-6 font-display text-heading-sm text-balance text-midnight-ink">
        {children}
      </blockquote>
    </Reveal>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="space-y-2.5">{children}</ul>;
}

export function LI({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 text-body text-driftwood">
      <span aria-hidden className="mt-[0.6em] h-px w-3 shrink-0 bg-fog" />
      <span>{children}</span>
    </li>
  );
}

// A multi-line config or response excerpt: mono on the warm-sand window the case-study Artifact
// uses. The text is the only child, so the Markdown twin's indented block carries the same
// characters, and long lines scroll inside the window instead of widening the page. The window
// takes keyboard focus so those lines can be scrolled without a pointer.
export function Code({ children }: { children: string }) {
  return (
    <pre
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-ash-border bg-warm-sand px-4 py-3 font-mono text-[13px] text-midnight-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
    >
      <code>{children}</code>
    </pre>
  );
}

export function Hr() {
  return <hr className="border-0 border-t border-ash-border" />;
}

// Emphasis inside a paragraph — lifts a phrase from driftwood body to ink.
export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-midnight-ink">{children}</strong>;
}

// Inline link — underline affordance that deepens on hover, never an accent hue (design.md).
export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className="text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
    >
      {children}
    </a>
  );
}
