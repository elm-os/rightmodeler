import type { Metadata } from "next";
import { BlogShell } from "@/components/blog/blog-shell";
import { CaseStudyCard } from "@/components/case-study/artifacts";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { CASE_STUDIES } from "@/content/case-studies";
import { CASE_STUDY_HUB } from "@/content/markdown/render-hub";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Case studies",
  description:
    "Two studies of per-workload model assignment: projected savings and a measured 100% pass rate on a 20-query benchmark at B:Side, and modeled savings at iAM360.",
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
            {CASE_STUDY_HUB.eyebrow}
          </p>
          <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
            {CASE_STUDY_HUB.title}
          </h1>
          <p className="mt-6 text-subheading text-driftwood">
            {CASE_STUDY_HUB.lede}
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
