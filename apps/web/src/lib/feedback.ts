// The rules both feedback routes share: app/api/feedback takes the website form, and
// app/api/feedback/agent takes a coding agent's POST. This file is the one place that says who
// gets the email, who it is from, the size caps, how each body is read, and what the notification
// shows. Pure and import-free on purpose: lib/handle-feedback.ts adds the Resend call, and
// scripts/feedback.test.mjs imports this file directly under Node's type stripping.

// The team recipients for feedback notifications (same inboxes as the waitlist).
export const FEEDBACK_RECIPIENTS = [
  "me@aakashharish.com",
  "me@ameyalambat.com",
];
// Verified Resend sending domain (rightmodeler.com).
const FROM = "rightmodeler <inquiry@rightmodeler.com>";

// Good-enough shape check to reject obvious junk before calling Resend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The form's textarea carries the same cap (maxLength in components/sections/feedback-form.tsx).
const MAX_MESSAGE_LENGTH = 5000;
// The optional fields a coding agent may send, with the cap on each.
const AGENT_FIELD_LIMITS = {
  agent: 100,
  version: 100,
  context: 1000,
  contact: 254,
} as const;
type AgentField = keyof typeof AGENT_FIELD_LIMITS;

export type Feedback = {
  // Which route took it: the website form, or a coding agent's POST.
  via: "form" | "agent";
  message: string;
  // The address to reply to. The form requires it; an agent sends one, as `contact`, only when
  // its user gave it.
  email?: string;
  agent?: string;
  version?: string;
  context?: string;
};

export type FeedbackResult = { feedback: Feedback } | { error: string };

// The body's top-level fields, or null when the body is not JSON. JSON that is not an object has
// no fields, so it fails on the first required one.
function fieldsOf(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

function readMessage(
  message: unknown,
): { message: string } | { error: string } {
  if (typeof message !== "string" || message.trim().length === 0) {
    return { error: "Write a message before sending." };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      error: `That message is too long. Please keep it under ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }
  return { message: message.trim() };
}

// The website form: an email address and a message, both required.
export function readFormFeedback(body: string): FeedbackResult {
  const sent = fieldsOf(body);
  if (!sent) return { error: "Invalid request." };

  const { email } = sent;
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return { error: "Enter a valid email address." };
  }

  const read = readMessage(sent.message);
  if ("error" in read) return read;

  return {
    feedback: { via: "form", message: read.message, email: email.trim() },
  };
}

// A coding agent: only the message is required, because an agent has no email address and
// rightmodeler has no accounts. An optional field that is absent, null or blank counts as not
// sent, and a field this route does not know is ignored.
export function readAgentFeedback(body: string): FeedbackResult {
  const sent = fieldsOf(body);
  if (!sent) return { error: "The request body must be valid JSON." };

  const read = readMessage(sent.message);
  if ("error" in read) return read;

  const given: { [name in AgentField]?: string } = {};
  for (const name of Object.keys(AGENT_FIELD_LIMITS) as AgentField[]) {
    const value = sent[name] ?? "";
    const max = AGENT_FIELD_LIMITS[name];
    if (typeof value !== "string" || value.length > max) {
      return {
        error: `The ${name} field must be a string of at most ${max.toLocaleString("en-US")} characters.`,
      };
    }
    if (value.trim()) given[name] = value.trim();
  }

  const { contact, ...details } = given;
  if (contact && !EMAIL_RE.test(contact)) {
    return { error: "The contact field must be a valid email address." };
  }

  return {
    feedback: {
      via: "agent",
      message: read.message,
      ...(contact ? { email: contact } : {}),
      ...details,
    },
  };
}

// The lines the notification shows, shared by its plain-text part and the React Email template
// (emails/feedback-notification.tsx) so the two cannot drift apart.
export function feedbackLines(
  { via, email, agent, version, context }: Feedback,
  submittedAt: string,
) {
  const fromAgent = via === "agent";
  return {
    subject: `New ${fromAgent ? "agent " : ""}feedback${email ? ` from ${email}` : ""}`,
    details: [
      ["Agent", agent],
      ["Version", version],
      ["Context", context],
    ].flatMap(([label, value]) => (value ? [`${label}: ${value}`] : [])),
    footer: `Submitted ${submittedAt} · www.rightmodeler.com/${fromAgent ? "api/feedback/agent" : "feedback"}`,
  };
}

// Everything Resend needs for the notification except the rendered template. replyTo is set only
// when there is an address to reply to.
export function feedbackEmail(feedback: Feedback, submittedAt: string) {
  const { subject, details, footer } = feedbackLines(feedback, submittedAt);
  return {
    from: FROM,
    to: FEEDBACK_RECIPIENTS,
    ...(feedback.email ? { replyTo: feedback.email } : {}),
    subject,
    text: [subject, ...details, "", feedback.message, "", footer].join("\n"),
  };
}
