// Markdown twin of the /privacy route (src/app/privacy/page.tsx). Keep the two in sync.

import { CONTACT_EMAIL } from "@/lib/site";

export const markdown = `# Privacy policy

Legal

What this site collects (very little), how it is used, and the choices you have.

Last updated July 10, 2026

The short version: we collect almost nothing, what you hand us stays with the team, and every list we run is one email away from removal.

## Who we are

rightmodeler is an ELM-OS project (referred to here as rightmodeler, we, or us). We operate this website at www.rightmodeler.com. Questions about this policy reach us at ${CONTACT_EMAIL}.

## What we collect

Two kinds of information, both small.

- Information you give us. If you join the Crucible or rightmodeler agent waitlist, we collect your email address. If you send feedback, we collect your email address and your message.
- Information collected automatically. We use Vercel Analytics to understand aggregate site usage: pages viewed, referrers, country, and device type. It is anonymized, does not use advertising cookies, and does not follow you across other sites.

## How we use it

- To send you the early-access note you asked for when you joined a waitlist.
- To read, and usually answer, the feedback you send us.
- To understand which pages are useful so we can improve the site.

We do not sell or rent your information, and we do not add you to marketing lists you did not ask for.

## Where it lives

Waitlist and feedback submissions are delivered by Resend as email to the founding team's inboxes. We do not run a separate marketing database today. The site itself is hosted on Vercel, whose infrastructure processes requests in order to serve these pages.

## Third parties

Two services process data on our behalf: Vercel (hosting and anonymized analytics) and Resend (email delivery for form submissions). Links that leave this site, to GitHub or LinkedIn for example, are governed by those sites' own policies.

## Your choices

Email us at ${CONTACT_EMAIL} to ask what we hold about you, to correct it, or to have it deleted. We honor deletion requests without ceremony.

## Children

This site is not directed to children under 13, and we do not knowingly collect their information.

## Changes

If this policy changes, we will update this page and the date at the top. Meaningful changes get called out plainly, not buried.
`;
