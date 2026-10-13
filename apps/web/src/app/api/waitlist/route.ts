// Answers ok only after Resend takes the email: no fake success.
// Node.js runtime: React Email rendering isn't Edge-safe.

import { Resend } from "resend";
import { WaitlistNotification } from "@/emails/waitlist-notification";

const RECIPIENTS = ["me@aakashharish.com", "me@ameyalambat.com"];
// Verified Resend sending domain (rightmodeler.com).
const FROM = "rightmodeler <inquiry@rightmodeler.com>";

// Good-enough shape check to reject obvious junk before calling Resend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let email: unknown;
  let product: unknown;
  try {
    const body = (await request.json()) as {
      email?: unknown;
      product?: unknown;
    } | null;
    email = body?.email;
    product = body?.product;
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
    console.error("RESEND_API_KEY is not set: cannot send waitlist email.");
    return Response.json(
      { error: "Waitlist is temporarily unavailable. Please try again later." },
      { status: 500 },
    );
  }

  const clean = email.trim();
  const submittedAt = new Date().toISOString();
  const resend = new Resend(apiKey);

  // Lenient: a missing or unknown product falls back to Crucible, so older clients keep working.
  const which =
    product === "agent" ? ("agent" as const) : ("crucible" as const);
  const label = which === "agent" ? "rightmodeler agent" : "Crucible";

  // The template is called as a function (Resend renders it) so this stays a route.ts with no JSX.
  const { error } = await resend.emails.send({
    from: FROM,
    to: RECIPIENTS,
    replyTo: clean,
    subject: `New ${label} waitlist signup: ${clean}`,
    react: WaitlistNotification({ email: clean, submittedAt, product: which }),
    text: `New ${label} waitlist signup: ${clean}\nSubmitted ${submittedAt} · www.rightmodeler.com/${which}`,
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
