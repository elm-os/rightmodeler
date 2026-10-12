// Tests for the rules both feedback routes share (src/lib/feedback.ts): how the form's body and a
// coding agent's body are read, each rejection and its message, the caps, and the email a
// submission becomes. Each route is one call into that module, so reading a body here is the
// validation the route performs. Nothing here calls Resend or sends email. Node 24 strips types
// natively, so the .ts module imports directly.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { webRoot } from "./check-content.mjs";
import {
  FEEDBACK_RECIPIENTS,
  feedbackEmail,
  readAgentFeedback,
  readFormFeedback,
} from "../src/lib/feedback.ts";

const body = (fields) => JSON.stringify(fields);
const source = (rel) => fs.readFileSync(path.join(webRoot, rel), "utf8");

const OWNER = "me@aakashharish.com";
const FROM = "rightmodeler <inquiry@rightmodeler.com>";
const AT = "2026-10-11T00:00:00.000Z";

const NOT_JSON = "The request body must be valid JSON.";
const NO_EMAIL = "Enter a valid email address.";
const NO_MESSAGE = "Write a message before sending.";
const TOO_LONG =
  "That message is too long. Please keep it under 5,000 characters.";
const NO_CONTACT = "The contact field must be a valid email address.";
const capped = (name, max) =>
  `The ${name} field must be a string of at most ${max} characters.`;

// The website form.

test("the form's body is read into trimmed feedback", () => {
  assert.deepEqual(
    readFormFeedback(
      body({ email: " you@company.com ", message: "  Rough edge.\n" }),
    ),
    {
      feedback: {
        via: "form",
        message: "Rough edge.",
        email: "you@company.com",
      },
    },
  );
});

// [raw body, expected error, why]
const FORM_REJECTIONS = [
  ["{not json", "Invalid request.", "a body that is not JSON"],
  ["", "Invalid request.", "an empty body"],
  ["null", NO_EMAIL, "JSON null, which has no fields"],
  [body(["you@company.com"]), NO_EMAIL, "an array, which has no fields"],
  [body({ message: "hi" }), NO_EMAIL, "a missing email"],
  [
    body({ email: ["you@company.com"], message: "hi" }),
    NO_EMAIL,
    "an email that is no string",
  ],
  [
    body({ email: "you@company", message: "hi" }),
    NO_EMAIL,
    "an email with no dot after the @",
  ],
  [
    body({ email: "you @company.com", message: "hi" }),
    NO_EMAIL,
    "an email with a space inside",
  ],
  [body({ email: "you@company.com" }), NO_MESSAGE, "a missing message"],
  [
    body({ email: "you@company.com", message: " \n " }),
    NO_MESSAGE,
    "a blank message",
  ],
  [
    body({ email: "you@company.com", message: ["hi"] }),
    NO_MESSAGE,
    "a message that is no string",
  ],
  [
    body({ email: "you@company.com", message: "x".repeat(5001) }),
    TOO_LONG,
    "a message one character past the cap",
  ],
  [
    body({ email: "you@company.com", message: `${"x".repeat(5000)}\n` }),
    TOO_LONG,
    "a message past the cap as typed, as the textarea counts it",
  ],
];

for (const [raw, error, why] of FORM_REJECTIONS) {
  test(`the form rejects ${why} with "${error}"`, () => {
    assert.deepEqual(readFormFeedback(raw), { error });
  });
}

test("the form takes a message of exactly 5,000 characters", () => {
  const message = "x".repeat(5000);
  assert.deepEqual(
    readFormFeedback(body({ email: "you@company.com", message })),
    { feedback: { via: "form", message, email: "you@company.com" } },
  );
});

test("the form's textarea stops at the cap the server enforces", () => {
  assert.ok(
    source("src/components/sections/feedback-form.tsx").includes(
      "maxLength={5000}",
    ),
    "feedback-form.tsx no longer caps its textarea at 5000 characters",
  );
});

// A coding agent.

test("an agent needs only a message, and no email", () => {
  assert.deepEqual(readAgentFeedback(body({ message: " The run stopped. " })), {
    feedback: { via: "agent", message: "The run stopped." },
  });
});

test("an agent's optional fields are kept, trimmed, with contact as the reply address", () => {
  assert.deepEqual(
    readAgentFeedback(
      body({
        message: "The run stopped.",
        agent: " claude-code ",
        version: "0.4.0",
        context: "init --through report; exit 2; plan_login_required\n",
        contact: " you@company.com ",
      }),
    ),
    {
      feedback: {
        via: "agent",
        message: "The run stopped.",
        email: "you@company.com",
        agent: "claude-code",
        version: "0.4.0",
        context: "init --through report; exit 2; plan_login_required",
      },
    },
  );
});

test("an optional field that is null or blank counts as not sent", () => {
  assert.deepEqual(
    readAgentFeedback(
      body({
        message: "m",
        agent: "",
        version: null,
        context: " \n ",
        contact: "",
      }),
    ),
    { feedback: { via: "agent", message: "m" } },
  );
});

test("a field the agent route does not know is ignored, not rejected", () => {
  assert.deepEqual(
    readAgentFeedback(
      body({
        message: "m",
        email: "you@company.com",
        traces: ["x"],
        nested: { agent: "claude-code" },
      }),
    ),
    { feedback: { via: "agent", message: "m" } },
  );
});

test("every agent field is accepted at exactly its cap", () => {
  const sent = {
    message: "m".repeat(5000),
    agent: "a".repeat(100),
    version: "v".repeat(100),
    context: "c".repeat(1000),
    contact: `${"x".repeat(249)}@b.co`,
  };
  assert.equal(sent.contact.length, 254);
  const { contact, ...rest } = sent;
  assert.deepEqual(readAgentFeedback(body(sent)), {
    feedback: { via: "agent", email: contact, ...rest },
  });
});

// [raw body, expected error, why]
const AGENT_REJECTIONS = [
  ["{not json", NOT_JSON, "a body that is not JSON"],
  ["", NOT_JSON, "an empty body"],
  ["[]", NO_MESSAGE, "JSON that is no object"],
  [body({}), NO_MESSAGE, "a missing message"],
  [body({ message: " \n " }), NO_MESSAGE, "a blank message"],
  [body({ message: 5 }), NO_MESSAGE, "a message that is no string"],
  [
    body({ message: "x".repeat(5001) }),
    TOO_LONG,
    "a message one character past the cap",
  ],
  [
    body({ message: "m", agent: "a".repeat(101) }),
    capped("agent", "100"),
    "an agent one character past its cap",
  ],
  [
    body({ message: "m", version: "v".repeat(101) }),
    capped("version", "100"),
    "a version one character past its cap",
  ],
  [
    body({ message: "m", context: "c".repeat(1001) }),
    capped("context", "1,000"),
    "a context one character past its cap",
  ],
  [
    body({ message: "m", contact: `${"x".repeat(250)}@b.co` }),
    capped("contact", "254"),
    "a contact one character past its cap",
  ],
  [
    body({ message: "m", version: 0.4 }),
    capped("version", "100"),
    "a number where a string belongs",
  ],
  [
    body({ message: "m", context: { command: "init" } }),
    capped("context", "1,000"),
    "an object where a string belongs",
  ],
  [
    body({ message: "m", contact: "not an address" }),
    NO_CONTACT,
    "a contact that is no email address",
  ],
];

for (const [raw, error, why] of AGENT_REJECTIONS) {
  test(`the agent route rejects ${why} with "${error}"`, () => {
    assert.deepEqual(readAgentFeedback(raw), { error });
  });
}

// The email a submission becomes.

const FORM_FEEDBACK = {
  via: "form",
  message: "Rough edge.",
  email: "you@company.com",
};
const AGENT_FEEDBACK = {
  via: "agent",
  message: "The run stopped.",
  agent: "claude-code",
  version: "0.4.0",
  context: "init --through report; exit 2; plan_login_required",
};

test(`${OWNER} receives every feedback email`, () => {
  assert.ok(
    FEEDBACK_RECIPIENTS.includes(OWNER),
    `${OWNER} was dropped from FEEDBACK_RECIPIENTS`,
  );
  for (const feedback of [FORM_FEEDBACK, AGENT_FEEDBACK]) {
    const { to } = feedbackEmail(feedback, AT);
    assert.deepEqual(to, FEEDBACK_RECIPIENTS);
    assert.ok(to.includes(OWNER), `${feedback.via} feedback skips ${OWNER}`);
  }
});

test("the form's email is unchanged: sender, reply address, subject and text", () => {
  assert.deepEqual(feedbackEmail(FORM_FEEDBACK, AT), {
    from: FROM,
    to: FEEDBACK_RECIPIENTS,
    replyTo: "you@company.com",
    subject: "New feedback from you@company.com",
    text: `New feedback from you@company.com\n\nRough edge.\n\nSubmitted ${AT} · www.rightmodeler.com/feedback`,
  });
});

test("an agent's email is marked as agent feedback and shows the fields it sent", () => {
  assert.deepEqual(feedbackEmail(AGENT_FEEDBACK, AT), {
    from: FROM,
    to: FEEDBACK_RECIPIENTS,
    subject: "New agent feedback",
    text: [
      "New agent feedback",
      "Agent: claude-code",
      "Version: 0.4.0",
      "Context: init --through report; exit 2; plan_login_required",
      "",
      "The run stopped.",
      "",
      `Submitted ${AT} · www.rightmodeler.com/api/feedback/agent`,
    ].join("\n"),
  });
});

test("replyTo is set only when the agent passed a contact", () => {
  assert.ok(!("replyTo" in feedbackEmail(AGENT_FEEDBACK, AT)));

  const email = feedbackEmail(
    { ...AGENT_FEEDBACK, email: "you@company.com" },
    AT,
  );
  assert.equal(email.replyTo, "you@company.com");
  assert.equal(email.subject, "New agent feedback from you@company.com");
});

test("both routes send through the shared handler, and only the rules name an address", () => {
  const calls = {
    "src/app/api/feedback/route.ts":
      /handleFeedback\(\s*request,\s*readFormFeedback\s*\)/,
    "src/app/api/feedback/agent/route.ts":
      /handleFeedback\(\s*request,\s*readAgentFeedback\s*\)/,
    "src/lib/handle-feedback.ts": /\.\.\.feedbackEmail\(/,
  };
  for (const [file, call] of Object.entries(calls)) {
    assert.match(source(file), call, `${file} bypasses the shared module`);
    assert.doesNotMatch(
      source(file),
      /[\w.+-]+@[\w-]+\.[a-z]+/i,
      `${file} names an email address; src/lib/feedback.ts owns them`,
    );
  }
});
