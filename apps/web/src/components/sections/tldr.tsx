// For emphasis inside the body, wrap a phrase in text-midnight-ink.

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
