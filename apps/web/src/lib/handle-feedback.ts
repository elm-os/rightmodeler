// What both feedback routes do with a POST, once each has named how its body is read: reject bad
// input, send the team a real notification via Resend, and answer ok only after Resend takes the
// email (no fake success). The rules it applies live in lib/feedback.ts.

import { Resend } from "resend";
import { FeedbackNotification } from "@/emails/feedback-notification";
import { feedbackEmail, type FeedbackResult } from "@/lib/feedback";

export async function handleFeedback(
  request: Request,
  read: (body: string) => FeedbackResult,
) {
  // A body that cannot be read at all is answered like one that is not JSON.
  const result = read(await request.text().catch(() => ""));
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Missing config is our fault, not the sender's: log loudly, fail honestly.
    console.error("RESEND_API_KEY is not set: cannot send feedback email.");
    return Response.json(
      { error: "Feedback is temporarily unavailable. Please try again later." },
      { status: 500 },
    );
  }

  const submittedAt = new Date().toISOString();
  // Pass the React Email template as a function call (Resend renders it) so this stays a plain
  // .ts file with no JSX.
  const { error } = await new Resend(apiKey).emails.send({
    ...feedbackEmail(result.feedback, submittedAt),
    react: FeedbackNotification({ ...result.feedback, submittedAt }),
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
