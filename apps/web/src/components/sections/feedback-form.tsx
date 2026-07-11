"use client";

// Feedback capture — email + message POSTed to /api/feedback, which sends the team a real
// notification via Resend (same pattern as the waitlist form: no fake success, the confirmation
// renders only after the API responds ok). Monochrome per docs/design.md — parchment fields with
// ash-border hairlines, ink button with press-scale; state communicated through copy, not colour.

import { useState } from "react";

type State =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; message: string };

const fieldClass =
  "min-w-0 w-full rounded-xl border border-ash-border bg-parchment-white px-4 py-3 font-sans text-body text-midnight-ink placeholder:text-fog focus:outline-none focus:ring-2 focus:ring-midnight-ink/40 focus:ring-offset-2 focus:ring-offset-parchment-white disabled:opacity-60";

export function FeedbackForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state.status === "submitting") return;
    setState({ status: "submitting" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message }),
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
      setMessage("");
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
        Got it, thank you. We read everything, and we reply to most of it.
      </p>
    );
  }

  const submitting = state.status === "submitting";

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-md flex-col gap-3">
      <label htmlFor="feedback-email" className="sr-only">
        Email address
      </label>
      <input
        id="feedback-email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        autoComplete="email"
        disabled={submitting}
        className={fieldClass}
      />
      <label htmlFor="feedback-message" className="sr-only">
        Your feedback
      </label>
      <textarea
        id="feedback-message"
        required
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="What should we know? Rough edges, missing features, things you want the agent to handle."
        rows={5}
        maxLength={5000}
        disabled={submitting}
        className={`${fieldClass} resize-y`}
      />
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex shrink-0 items-center justify-center self-start rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send feedback"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-body text-driftwood">
          {state.message}
        </p>
      )}
    </form>
  );
}
