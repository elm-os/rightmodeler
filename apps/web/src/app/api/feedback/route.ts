// POST /api/feedback — the feedback form backend. Validates the submitted email and message and
// sends the team a real notification via Resend (no fake success; the client only shows a
// confirmation after this responds ok). Mirrors api/waitlist/route.ts: Node.js runtime (React
// Email rendering isn't Edge-safe), dynamic because it reads the request body — fine under Cache
// Components.

import { Resend } from "resend";
import { FeedbackNotification } from "@/emails/feedback-notification";

// The team recipients for feedback notifications (same inboxes as the waitlist).
const RECIPIENTS = ["me@aakashharish.com", "me@ameyalambat.com"];
// Verified Resend sending domain (rightmodeler.com).
const FROM = "rightmodeler <inquiry@rightmodeler.com>";

// Good-enough shape check to reject obvious junk before calling Resend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE_LENGTH = 5000;

export async function POST(request: Request) {
  let email: unknown;
  let message: unknown;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      message?: unknown;
    } | null;
    email = body?.email;
    message = body?.message;
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return Response.json(
      { error: "Enter a valid email address." },
      { status: 400 },
    );
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return Response.json(
      { error: "Write a message before sending." },
      { status: 400 },
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json(
      {
        error:
          "That message is too long. Please keep it under 5,000 characters.",
      },
      { status: 400 },
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Missing config is our fault, not the visitor's — log loudly, fail honestly.
    console.error("RESEND_API_KEY is not set — cannot send feedback email.");
    return Response.json(
      { error: "Feedback is temporarily unavailable. Please try again later." },
      { status: 500 },
    );
  }

  const cleanEmail = email.trim();
  const cleanMessage = message.trim();
  const submittedAt = new Date().toISOString();
  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: FROM,
    to: RECIPIENTS,
    replyTo: cleanEmail,
    subject: `New feedback from ${cleanEmail}`,
    react: FeedbackNotification({
      email: cleanEmail,
      message: cleanMessage,
      submittedAt,
    }),
    text: `New feedback from ${cleanEmail}\n\n${cleanMessage}\n\nSubmitted ${submittedAt} · rightmodeler.com/feedback`,
  });

  if (error) {
    console.error("Resend send failed:", error);
    return Response.json(
      { error: "Couldn't send that right now. Please try again." },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
