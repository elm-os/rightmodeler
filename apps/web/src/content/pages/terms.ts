// Markdown twin of the /terms route (src/app/terms/page.tsx). Keep the two in sync.

import { CONTACT_EMAIL, LICENSE_URL, REPO_URL } from "@/lib/site";

export const markdown = `# Terms of service

Legal

Short, and the plain-English summary matches the letter.

Last updated July 10, 2026

Browse freely, the pre-release products may change, and every figure on this site is an illustrative example. The details follow.

## Agreement

By using www.rightmodeler.com (the site), operated by rightmodeler, an ELM-OS project (rightmodeler, we, or us), you agree to these terms. If you do not agree, do not use the site.

## The service

The site describes the rightmodeler CLI, rightmodeler agent, and Crucible, and offers early-access waitlists and a feedback form. Products described as coming soon or in early access are pre-release: their features, availability, and pricing may change or be withdrawn without notice, and joining a waitlist does not guarantee access.

## The software

rightmodeler is open source. The code is distributed through its [GitHub repository](${REPO_URL}) under the [MIT license](${LICENSE_URL}), and is governed by that license and the notices in that repository, not by these terms. Running it is your responsibility: it works against your own traces with your own API keys, and you review every change it recommends before applying it.

## Illustrative figures

Savings percentages, quality scores, latency deltas, and similar numbers shown on this site are illustrative examples, labeled as such. They are not measurements of your workload and not a promise of results. What you can actually save is exactly what the tool exists to measure, on your own traces.

## Acceptable use

Do not misuse the site: no attempts to disrupt it, probe it for vulnerabilities outside responsible disclosure, scrape it at abusive volume, or use it for anything unlawful.

## Intellectual property

The site's content, design, and the rightmodeler name and wordmark belong to us. Feedback you send may be used to improve our products without obligation to you.

## No warranties

The site is provided as is and as available, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.

## Limitation of liability

To the maximum extent permitted by law, rightmodeler will not be liable for indirect, incidental, special, consequential, or punitive damages, or any loss of profits, data, or goodwill, arising from your use of the site. Our total liability for any claim relating to the site will not exceed one hundred US dollars.

## Changes

We may update these terms or change or discontinue the site at any time. If the terms change, we will update this page and the date at the top; continued use after a change means you accept the updated terms.

## Governing law

These terms are governed by the laws of the State of Delaware, USA, without regard to conflict-of-law rules. Disputes will be resolved in the courts located in Delaware.

## Contact

${CONTACT_EMAIL}
`;
