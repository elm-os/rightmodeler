// TL;DR — the one or two sentence summary every page carries near the top. An editorial lede, not a
// filled card: a quiet mono kicker over a slightly larger line, anchored by a single hairline rule
// (docs/design.md favours hairlines and type hierarchy over boxes). Emphasis inside the body comes
// from ink weight (wrap a phrase in text-midnight-ink), never colour.

import type { ReactNode } from "react";

export function Tldr({ children }: { children: ReactNode }) {
  return (
    <div className="border-l-2 border-ash-border pl-5 sm:pl-6">
      <p className="font-mono text-caption uppercase text-fog">TL;DR</p>
      <p className="mt-2 max-w-2xl text-subheading text-driftwood">
        {children}
      </p>
    </div>
  );
}
