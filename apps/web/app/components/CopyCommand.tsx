"use client";

// Primary CTA field — a copy-able command (adapted from Skiper's smooth-caret input, re-branded
// monochrome). Click copies to the clipboard and the copy glyph morphs to a check. Mono 13px on
// a warm-sand surface with an ash-border hairline; press-scale for physical feedback.

import { useRef, useState } from "react";
import { CopyIcon, CheckIcon } from "./icons";

export function CopyCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — no-op
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied to clipboard" : `Copy command: ${command}`}
      className={`group inline-flex items-start gap-3 rounded-xl border border-ash-border bg-warm-sand px-4 py-3 text-left transition-transform duration-150 ease-out-strong active:scale-[0.98] ${className ?? ""}`}
    >
      <span aria-hidden className="select-none font-mono text-[13px] text-fog">
        $
      </span>
      <code className="font-mono text-[13px] text-midnight-ink">{command}</code>
      <span className="ml-1 text-driftwood transition-colors duration-150 group-hover:text-midnight-ink">
        {copied ? (
          <CheckIcon className="h-4 w-4" />
        ) : (
          <CopyIcon className="h-4 w-4" />
        )}
      </span>
    </button>
  );
}
