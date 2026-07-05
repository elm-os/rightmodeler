"use client";

// Primary CTA field — a copy-able command (adapted from Skiper's smooth-caret input, re-branded
// monochrome). Click copies to the clipboard and the copy glyph morphs to a check. Mono 13px on
// a warm-sand surface with an ash-border hairline; press-scale for physical feedback.

import { useRef, useState } from "react";
import { CopyIcon, CheckIcon } from "./icons";

export function CopyCommand({
  command,
  className,
  mono = true,
}: {
  command: string;
  className?: string;
  mono?: boolean;
}) {
  const font = mono ? "font-mono text-[12px]" : "font-sans text-[13px]";
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
      className={`group inline-flex items-start gap-2 text-left transition-transform duration-150 ease-out-strong active:scale-[0.98] ${className ?? ""}`}
    >
      <span aria-hidden className={`select-none ${font} text-fog`}>
        $
      </span>
      <code className={`${font} text-midnight-ink`}>{command}</code>
      <span className="ml-1 text-driftwood transition-colors duration-150 group-hover:text-midnight-ink">
        {copied ? (
          <CheckIcon className="h-3.5 w-3.5" />
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
      </span>
    </button>
  );
}
