// Markdown twin of the /feedback route (src/app/feedback/page.tsx). Keep in sync with that page.

import { CONTACT_EMAIL, SITE_URL } from "@/lib/site";

export const markdown = `# Tell us where to aim.

Feedback

Rough edges, missing features, trace formats we should read, steps the agent should never touch. We read everything, and it shapes what ships next.

## Send feedback

The page carries a short feedback form. It is interactive, so it cannot be completed from this Markdown representation. Open it in a browser to use it:

    ${SITE_URL}/feedback

The form asks for two things: an email address, placeholder "you@company.com", and a free-text message, placeholder "What should we know? Rough edges, missing features, things you want the agent to handle." The submit button reads "Send feedback", and while the message is in flight it reads "Sending...". When it goes through, the form is replaced by a confirmation: "Got it, thank you. We read everything, and we reply to most of it."

## Prefer email

Prefer email? Reach us directly at ${CONTACT_EMAIL}. Replies come from a founder, not a queue.
`;
