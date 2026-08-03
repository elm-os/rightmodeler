// Case-study index: the two customer stories as full-card links, in the blog frame. Static and
// registry-driven (src/content/case-studies.ts), so a new study means one registry entry and its
// route file, and this page, the landing band, sitemap, and llms.txt stay in step.

import type { Metadata } from "next";
import { BlogShell } from "@/components/blog/blog-shell";
import { CaseStudyCard } from "@/components/case-study/artifacts";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { CASE_STUDIES } from "@/content/case-studies";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Case studies",
  description:
    "Two per-workload routing studies with modeled savings; B:Side also reports a measured 100% pass rate on a 20-query benchmark.",
  path: "/case-study",
});

const listLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  itemListElement: CASE_STUDIES.map((study, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: study.title,
    url: `${SITE_URL}/case-study/${study.slug}`,
  })),
};

export default function CaseStudiesPage() {
  return (
    <BlogShell>
      <JsonLd data={breadcrumbLd("Case studies", "/case-study")} />
      <JsonLd data={listLd} />

      <div className="px-6 pt-16 pb-16 sm:px-8 sm:pt-24 sm:pb-20">
        <Reveal className="mx-auto max-w-2xl">
          <p className="font-mono text-caption text-fog uppercase">
            Case studies
          </p>
          <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
            What right-sizing actually saves.
          </h1>
          <p className="mt-6 text-subheading text-driftwood">
            Both studies report modeled savings from per-workload routing.
            B:Side also reports a measured 100% pass rate on its 20-query
            benchmark; iAM360 reports its routing and validation procedure
            without a measured quality result.
          </p>
        </Reveal>

        <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
          {CASE_STUDIES.map((study, i) => (
            <Reveal key={study.slug} delay={i * 0.06} className="h-full">
              <CaseStudyCard study={study} titleAs="h2" />
            </Reveal>
          ))}
        </div>
      </div>
    </BlogShell>
  );
}
