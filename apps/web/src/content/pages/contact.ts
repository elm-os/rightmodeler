// Mirrors /contact (src/app/contact/page.tsx). Keep in sync when the page changes.

import {
  CONTACT_EMAIL,
  ISSUES_NEW_URL,
  RUN_COMMAND,
  SECURITY_URL,
  SITE_URL,
} from "@/lib/site";

export const markdown = `# Reach the people who build it.

rightmodeler is a small team, and every channel below reaches a person. Pick the one that matches what you have: a question, a bug, an idea, or a security report.

There is no support queue and no ticket number. Email reaches a founder, issues land next to the code, and the feedback form goes straight to the people deciding what ships next.

## Email

Write to ${CONTACT_EMAIL} about anything: what the CLI actually measures, whether your trace format is supported, licensing, partnerships, or press. Name the step and the report line you are asking about and the answer comes back faster.

## Bugs and feature requests

File those in the open-source repository so the thread stays next to the code:

    ${ISSUES_NEW_URL}

Both have templates, and the issue you open is the one we work from. If a result looks wrong, say which step and which candidate, and we will tell you what the tool measured and why it decided that way.

## Product feedback

Use the feedback form at ${SITE_URL}/feedback for rough edges, trace formats you want read, and steps the agent should never touch. It goes straight to the team and it shapes what ships next. Reach for it when there is nothing to file and nothing to look up.

## Security

Do not open a public issue for a vulnerability. Email ${CONTACT_EMAIL} with what the issue is, where it lives, and how to reproduce it. We acknowledge within five business days and credit you in the release notes unless you would rather stay anonymous. The security policy carries the full scope:

    ${SECURITY_URL}

## What we cannot do over email

We cannot look at your traces. rightmodeler runs locally, against your own traces and your own provider key, and there is no rightmodeler server holding them. If you want a second read on a result, paste the per-step summary from the report rather than the trace. It is a report, not a runtime gateway, and that holds for support too.

## Follow the work

Releases, measurement notes, and the occasional argument about evaluation go out on GitHub, LinkedIn, X, and Reddit.

## Before you write

### Do you offer paid support?

Not yet. The CLI is MIT licensed and the issue tracker is the support channel. If you are running rightmodeler across a large stack and want help reading the reports, write to us and say what you are running and which steps you are unsure about.

### Can I get a demo?

There is nothing to demo that you cannot run yourself. ${RUN_COMMAND} points at traces you already have and returns a real report on your own steps in one sitting. If you want a second read on a report you already generated, email the per-step summary.

### Do you take contributions?

Yes. The repository is MIT licensed and CONTRIBUTING.md has the setup. Trace-format support, docs, and bug fixes are all welcome. A failing case pulled from a real trace is worth more to us than a feature request.

### How do I stay in the loop?

Watch the repository for releases, or follow the accounts linked above. The waitlists on the agent and Crucible pages send one note when early access opens, and nothing else.
`;
