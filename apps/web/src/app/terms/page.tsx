import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { A, H2, Lead, P, Prose } from "@/components/blog/prose";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Terms of service",
  description:
    "The terms that govern use of the rightmodeler website, in plain English: pre-release products may change, figures are illustrative, and the software is licensed in its repository.",
  path: "/terms",
});

// Same quiet treatment as the privacy policy: no gradient, prose primitives, dated mono kicker.
export default function TermsPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Terms of service", "/terms")} />

      <PageHero
        eyebrow="Legal"
        title="Terms of service"
        lede="Short, and the plain-English summary matches the letter."
        gradient={false}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white py-16 sm:py-20">
        <Prose>
          <p className="font-mono text-caption uppercase text-fog">
            Last updated July 10, 2026
          </p>

          <Lead>
            Browse freely, the pre-release products may change, and every figure
            on this site is an illustrative example. The details follow.
          </Lead>

          <H2>Agreement</H2>
          <P>
            By using www.rightmodeler.com (the site), operated by rightmodeler,
            an ELM-OS project (rightmodeler, we, or us), you agree to these
            terms. If you do not agree, do not use the site.
          </P>

          <H2>The service</H2>
          <P>
            The site describes the rightmodeler skill, rightmodeler agent, and
            Crucible, and offers early-access waitlists and a feedback form.
            Products described as coming soon or in early access are
            pre-release: their features, availability, and pricing may change or
            be withdrawn without notice, and joining a waitlist does not
            guarantee access.
          </P>

          <H2>The software</H2>
          <P>
            The rightmodeler code is distributed through its{" "}
            <A href="https://github.com/elm-os/rightmodeler">
              GitHub repository
            </A>{" "}
            and is governed by the license and notices in that repository, not
            by these terms. Running it is your responsibility: it works against
            your own traces with your own API keys, and you review every change
            it recommends before applying it.
          </P>

          <H2>Illustrative figures</H2>
          <P>
            Savings percentages, quality scores, latency deltas, and similar
            numbers shown on this site are illustrative examples, labeled as
            such. They are not measurements of your workload and not a promise
            of results. What you can actually save is exactly what the tool
            exists to prove, on your own traces.
          </P>

          <H2>Acceptable use</H2>
          <P>
            Do not misuse the site: no attempts to disrupt it, probe it for
            vulnerabilities outside responsible disclosure, scrape it at abusive
            volume, or use it for anything unlawful.
          </P>

          <H2>Intellectual property</H2>
          <P>
            The site&rsquo;s content, design, and the rightmodeler name and
            wordmark belong to us. Feedback you send may be used to improve our
            products without obligation to you.
          </P>

          <H2>No warranties</H2>
          <P>
            The site is provided as is and as available, without warranties of
            any kind, express or implied, including merchantability, fitness for
            a particular purpose, and non-infringement.
          </P>

          <H2>Limitation of liability</H2>
          <P>
            To the maximum extent permitted by law, rightmodeler will not be
            liable for indirect, incidental, special, consequential, or punitive
            damages, or any loss of profits, data, or goodwill, arising from
            your use of the site. Our total liability for any claim relating to
            the site will not exceed one hundred US dollars.
          </P>

          <H2>Changes</H2>
          <P>
            We may update these terms or change or discontinue the site at any
            time. If the terms change, we will update this page and the date at
            the top; continued use after a change means you accept the updated
            terms.
          </P>

          <H2>Governing law</H2>
          <P>
            These terms are governed by the laws of the State of Delaware, USA,
            without regard to conflict-of-law rules. Disputes will be resolved
            in the courts located in Delaware.
          </P>

          <H2>Contact</H2>
          <P>
            <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>
          </P>

          <div className="border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/privacy", label: "Privacy policy" },
                { href: "/feedback", label: "Send us feedback" },
              ]}
            />
          </div>
        </Prose>
      </section>
    </PageShell>
  );
}
