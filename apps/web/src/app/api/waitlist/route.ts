// POST /api/waitlist — the Crucible "get early access" backend. Validates the submitted email and
// sends the team a real notification via Resend (no fake success; the client only shows a
// confirmation after this responds ok). Runs on the Node.js runtime (default) because React Email
// rendering isn't Edge-safe; it reads the request body, so it's dynamic — fine under Cache Components.

import { Resend } from "resend";
import { WaitlistNotification } from "@/emails/waitlist-notification";

// The team recipients for waitlist notifications.
const RECIPIENTS = ["me@aakashharish.com", "me@ameyalambat.com"];
// Verified Resend sending domain (rightmodeler.com).
const FROM = "rightmodeler <inquiry@rightmodeler.com>";

// Good-enough shape check to reject obvious junk before calling Resend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let email: unknown;
  try {
    const body = await request.json();
    email = (body as { email?: unknown } | null)?.email;
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return Response.json(
      { error: "Enter a valid email address." },
      { status: 400 },
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Missing config is our fault, not the visitor's — log loudly, fail honestly.
    console.error("RESEND_API_KEY is not set — cannot send waitlist email.");
    return Response.json(
      { error: "Waitlist is temporarily unavailable. Please try again later." },
      { status: 500 },
    );
  }

  const clean = email.trim();
  const submittedAt = new Date().toISOString();
  const resend = new Resend(apiKey);

  // Pass the React Email template as a function call (Resend renders it) so this stays a plain
  // route.ts with no JSX. Resend also derives the plain-text part from the same component.
  const { error } = await resend.emails.send({
    from: FROM,
    to: RECIPIENTS,
    replyTo: clean,
    subject: `New Crucible waitlist signup: ${clean}`,
    react: WaitlistNotification({ email: clean, submittedAt }),
    text: `New Crucible waitlist signup: ${clean}\nSubmitted ${submittedAt}`,
  });

  if (error) {
    console.error("Resend send failed:", error);
    return Response.json(
      { error: "Couldn't add you right now. Please try again." },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
