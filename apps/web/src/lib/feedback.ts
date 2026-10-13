// Import-free on purpose: scripts/feedback.test.mjs loads this file under Node's type stripping.

// Same inboxes as the waitlist (app/api/waitlist/route.ts).
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
const AGENT_FIELD_LIMITS = {
  agent: 100,
  version: 100,
  context: 1000,
  contact: 254,
} as const;
type AgentField = keyof typeof AGENT_FIELD_LIMITS;

export type Feedback = {
  via: "form" | "agent";
  message: string;
  email?: string;
  agent?: string;
  version?: string;
  context?: string;
};

export type FeedbackResult = { feedback: Feedback } | { error: string };

// null when the body is not JSON. Non-object JSON has no fields, so the first required one fails.
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

// Only the message is required: an agent has no email address and rightmodeler has no accounts.
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

// Shared by the plain-text part and emails/feedback-notification.tsx so the two cannot drift apart.
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
