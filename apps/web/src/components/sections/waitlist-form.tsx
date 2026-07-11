"use client";

// Waitlist capture — a single email field + submit that POSTs to /api/waitlist, which sends the
// team a real notification via Resend. No fake success: the confirmation renders only after the
// API responds ok. Monochrome per docs/design.md — parchment field with an ash-border hairline, ink
// button with press-scale; state is communicated through copy, not colour (no green/red).
// `product` tags which waitlist the signup belongs to (Crucible by default, or the agent).

import { useState } from "react";

export type WaitlistProduct = "crucible" | "agent";

type State =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; message: string };

export function WaitlistForm({
  product = "crucible",
}: {
  product?: WaitlistProduct;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state.status === "submitting") return;
    setState({ status: "submitting" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, product }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setState({
          status: "error",
          message: data?.error ?? "Something went wrong. Please try again.",
        });
        return;
      }
      setState({ status: "success" });
      setEmail("");
    } catch {
      setState({
        status: "error",
        message: "Network error. Please try again.",
      });
    }
  }

  if (state.status === "success") {
    return (
      <p className="max-w-md text-body text-midnight-ink">
        You’re on the list. We’ll be in touch when early access opens.
      </p>
    );
  }

  const submitting = state.status === "submitting";

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-md flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor={`waitlist-email-${product}`} className="sr-only">
          Email address
        </label>
        <input
          id={`waitlist-email-${product}`}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          disabled={submitting}
          className="min-w-0 flex-1 rounded-xl border border-ash-border bg-parchment-white px-4 py-3 font-sans text-body text-midnight-ink placeholder:text-fog focus:outline-none focus:ring-2 focus:ring-midnight-ink/40 focus:ring-offset-2 focus:ring-offset-parchment-white disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex shrink-0 items-center justify-center rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Get early access"}
        </button>
      </div>
      {state.status === "error" && (
        <p role="alert" className="text-body text-driftwood">
          {state.message}
        </p>
      )}
    </form>
  );
}
