import type { Metadata } from "next";
import Link from "next/link";
import { A, H2, Hr, Lead, P, Prose } from "@/components/blog/prose";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { SocialLinks } from "@/components/sections/social-links";
import {
  breadcrumbLd,
  ORGANIZATION_ID,
  organizationLd,
  pageMetadata,
} from "@/lib/seo";
import {
  CONTACT_EMAIL,
  ISSUES_NEW_URL,
  RUN_COMMAND,
  SECURITY_URL,
  SITE_URL,
} from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Contact",
  description:
    "Reach the rightmodeler team: email for questions and licensing, GitHub issues for bugs and feature requests, the feedback form for product input, and a security policy for vulnerability reports.",
  path: "/contact",
});

// ContactPage points at the same Organization node the home page and /about emit, so the graph
// carries one entity with one set of contact points rather than three copies.
const contactPageLd = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  name: "Contact rightmodeler",
  url: `${SITE_URL}/contact`,
  mainEntity: { "@id": ORGANIZATION_ID },
};

const FAQ: FaqItem[] = [
  {
    q: "Do you offer paid support?",
    a: "Not yet. The CLI is MIT licensed and the issue tracker is the support channel. If you are running rightmodeler across a large stack and want help reading the reports, write to us and say what you are running and which steps you are unsure about.",
  },
  {
    q: "Can I get a demo?",
    a: `There is nothing to demo that you cannot run yourself. ${RUN_COMMAND} points at traces you already have and returns a real report on your own steps in one sitting. If you want a second read on a report you already generated, email the per-step summary.`,
  },
  {
    q: "Do you take contributions?",
    a: "Yes. The repository is MIT licensed and CONTRIBUTING.md has the setup. Trace-format support, docs, and bug fixes are all welcome. A failing case pulled from a real trace is worth more to us than a feature request.",
  },
  {
    q: "How do I stay in the loop?",
    a: "Watch the repository for releases, or follow the accounts linked above. The waitlists on the agent and Crucible pages send one note when early access opens, and nothing else.",
  },
];

export default function ContactPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Contact", "/contact")} />
      <JsonLd data={organizationLd()} />
      <JsonLd data={contactPageLd} />

      <PageHero
        eyebrow="Contact"
        title="Reach the people who build it."
        lede="rightmodeler is a small team, and every channel below reaches a person. Pick the one that matches what you have: a question, a bug, an idea, or a security report."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white py-16 sm:py-20">
        <Prose>
          <Lead>
            There is no support queue and no ticket number. Email reaches a
            founder, issues land next to the code, and the feedback form goes
            straight to the people deciding what ships next.
          </Lead>

          {/* Sorted by what you are writing about rather than by channel: each route has a
              different destination and a different honest expectation, and that is the part
              worth knowing before you pick one. */}
          <H2>Email</H2>
          <P>
            Write to <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>{" "}
            about anything: what the CLI actually measures, whether your trace
            format is supported, licensing, partnerships, or press. Name the
            step and the report line you are asking about and the answer comes
            back faster.
          </P>

          <H2>Bugs and feature requests</H2>
          <P>
            File those{" "}
            <A href={ISSUES_NEW_URL}>in the open-source repository</A> so the
            thread stays next to the code. Both have templates, and the issue
            you open is the one we work from. If a result looks wrong, say which
            step and which candidate, and we will tell you what the tool
            measured and why it decided that way.
          </P>

          <H2>Product feedback</H2>
          <P>
            Use the <Link href="/feedback">feedback form</Link> for rough edges,
            trace formats you want read, and steps the agent should never touch.
            It goes straight to the team and it shapes what ships next. Reach
            for it when there is nothing to file and nothing to look up.
          </P>

          <H2>Security</H2>
          <P>
            Do not open a public issue for a vulnerability. Email{" "}
            <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A> with what
            the issue is, where it lives, and how to reproduce it. We
            acknowledge within five business days and credit you in the release
            notes unless you would rather stay anonymous. The{" "}
            <A href={SECURITY_URL}>security policy</A> carries the full scope.
          </P>

          <H2>What we cannot do over email</H2>
          <P>
            We cannot look at your traces. rightmodeler runs locally, against
            your own traces and your own provider key, and there is no
            rightmodeler server holding them. If you want a second read on a
            result, paste the per-step summary from the report rather than the
            trace. It is a report, not a runtime gateway, and that holds for
            support too.
          </P>

          <H2>Follow the work</H2>
          <P>
            Releases, measurement notes, and the occasional argument about
            evaluation go out on GitHub, LinkedIn, X, and Reddit.
          </P>
          <SocialLinks className="-ml-2.5" />

          <Hr />

          <RelatedLinks
            links={[
              { href: "/feedback", label: "Send feedback" },
              { href: "/about", label: "About rightmodeler" },
              { href: "/how-it-works", label: "How it works" },
              { href: "/privacy", label: "Privacy policy" },
            ]}
          />
        </Prose>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <Faq items={FAQ} heading="Before you write" />
    </PageShell>
  );
}
