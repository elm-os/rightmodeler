import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { A, H2, Lead, LI, P, Prose, UL } from "@/components/blog/prose";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Privacy policy",
  description:
    "How rightmodeler handles your information: what this site collects (very little), how it is used, where it lives, and how to reach us.",
  path: "/privacy",
});

// Legal pages stay quiet: no gradient masthead, the prose primitives for rhythm, and a dated
// mono kicker so readers can tell at a glance whether anything changed since their last visit.
export default function PrivacyPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Privacy policy", "/privacy")} />

      <PageHero
        eyebrow="Legal"
        title="Privacy policy"
        lede="What this site collects (very little), how it is used, and the choices you have."
        gradient={false}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white py-16 sm:py-20">
        <Prose>
          <p className="font-mono text-caption uppercase text-fog">
            Last updated July 10, 2026
          </p>

          <Lead>
            The short version: we collect almost nothing, what you hand us
            stays with the team, and every list we run is one email away from
            removal.
          </Lead>

          <H2>Who we are</H2>
          <P>
            rightmodeler is an ELM-OS project (referred to here as
            rightmodeler, we, or us). We operate this website at
            www.rightmodeler.com. Questions about this policy reach us at{" "}
            <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>.
          </P>

          <H2>What we collect</H2>
          <P>Two kinds of information, both small.</P>
          <UL>
            <LI>
              Information you give us. If you join the Crucible or
              rightmodeler agent waitlist, we collect your email address. If
              you send feedback, we collect your email address and your
              message.
            </LI>
            <LI>
              Information collected automatically. We use Vercel Analytics to
              understand aggregate site usage: pages viewed, referrers,
              country, and device type. It is anonymized, does not use
              advertising cookies, and does not follow you across other sites.
            </LI>
          </UL>

          <H2>How we use it</H2>
          <UL>
            <LI>
              To send you the early-access note you asked for when you joined
              a waitlist.
            </LI>
            <LI>To read, and usually answer, the feedback you send us.</LI>
            <LI>
              To understand which pages are useful so we can improve the site.
            </LI>
          </UL>
          <P>
            We do not sell or rent your information, and we do not add you to
            marketing lists you did not ask for.
          </P>

          <H2>Where it lives</H2>
          <P>
            Waitlist and feedback submissions are delivered by Resend as email
            to the founding team&rsquo;s inboxes. We do not run a separate
            marketing database today. The site itself is hosted on Vercel,
            whose infrastructure processes requests in order to serve these
            pages.
          </P>

          <H2>Third parties</H2>
          <P>
            Two services process data on our behalf: Vercel (hosting and
            anonymized analytics) and Resend (email delivery for form
            submissions). Links that leave this site, to GitHub or LinkedIn
            for example, are governed by those sites&rsquo; own policies.
          </P>

          <H2>Your choices</H2>
          <P>
            Email us at <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>{" "}
            to ask what we hold about you, to correct it, or to have it
            deleted. We honor deletion requests without ceremony.
          </P>

          <H2>Children</H2>
          <P>
            This site is not directed to children under 13, and we do not
            knowingly collect their information.
          </P>

          <H2>Changes</H2>
          <P>
            If this policy changes, we will update this page and the date at
            the top. Meaningful changes get called out plainly, not buried.
          </P>

          <div className="border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/terms", label: "Terms of service" },
                { href: "/feedback", label: "Send us feedback" },
              ]}
            />
          </div>
        </Prose>
      </section>
    </PageShell>
  );
}
