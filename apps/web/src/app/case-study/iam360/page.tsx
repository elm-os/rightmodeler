// Case study: iAM360. The AI coach behind a fitness and wellness platform moved from a modeled
// all-Terra/xhigh default to a routed architecture that concentrates intelligence: Sol for the
// hardest coaching paths, Terra for moderate analysis, small validated models for routine work.
// Wears the blog article surface with the case-study kit; the before/after grid stays local.
// Fully static; figures are quoted verbatim from the engagement write-up and stamped as modeled,
// including the sensitivity of the headline number to the xhigh output assumption.

import type { Metadata } from "next";
import { BlogCta } from "@/components/blog/blog-cta";
import { BlogShell } from "@/components/blog/blog-shell";
import {
  H2,
  Lead,
  P,
  Prose,
  PullQuote,
  Strong,
  A,
} from "@/components/blog/prose";
import {
  Artifact,
  CaseStudyHeader,
  KVRows,
  RouteRows,
  StatCell,
} from "@/components/case-study/artifacts";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { IAM360 } from "@/content/case-studies";
import { SITE_AUTHOR, SITE_NAME, SITE_URL } from "@/lib/site";

const study = IAM360;
const url = `${SITE_URL}/case-study/${study.slug}`;

export const metadata: Metadata = {
  title: { absolute: `${study.company} case study · ${SITE_NAME}` },
  description: study.description,
  alternates: { canonical: `/case-study/${study.slug}` },
  openGraph: {
    type: "article",
    title: study.title,
    description: study.description,
    url,
    siteName: SITE_NAME,
    publishedTime: study.date,
    authors: [SITE_AUTHOR],
    images: [
      { url: study.hero.src, width: 1200, height: 630, alt: study.hero.alt },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: study.title,
    description: study.description,
    images: [study.hero.src],
  },
};

const articleLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: study.title,
  description: study.description,
  image: `${SITE_URL}${study.hero.src}`,
  datePublished: study.date,
  dateModified: study.date,
  author: { "@type": "Organization", name: SITE_AUTHOR },
  publisher: {
    "@type": "Organization",
    name: SITE_NAME,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` },
  },
  mainEntityOfPage: { "@type": "WebPage", "@id": url },
  about: {
    "@type": "Organization",
    name: study.company,
    url: study.website,
  },
  mentions: [
    {
      "@type": "Person",
      name: study.testimonial.name,
      jobTitle: study.testimonial.jobTitle,
      sameAs: study.testimonial.sameAs,
      worksFor: {
        "@type": "Organization",
        name: study.testimonial.org.name,
        url: study.testimonial.org.url,
        sameAs: study.testimonial.org.sameAs,
      },
    },
  ],
};

const breadcrumbLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
    {
      "@type": "ListItem",
      position: 2,
      name: "Case studies",
      item: `${SITE_URL}/case-study`,
    },
    { "@type": "ListItem", position: 3, name: study.title, item: url },
  ],
};

// Each job assigned to the appropriate level of AI. Note the direction goes both ways: the
// hardest paths were upgraded to Sol while validated routine work moved to small models.
const POLICY = [
  {
    route: "gpt-5.6-sol",
    covers: "complex coaching and personalized planning",
  },
  { route: "gpt-5.6-terra", covers: "moderate analysis" },
  {
    route: "gpt-oss-20b · groq",
    covers: "straightforward, heavily validated work",
  },
  { route: "gpt-oss-120b", covers: "a small number of controlled fallbacks" },
];

// Previously modeled approach vs the current one, pairwise.
const CHANGES = [
  {
    before: "The same expensive model handled everything",
    after: "Each task uses an appropriately capable model",
  },
  {
    before: "Maximum reasoning, even for simple work",
    after: "Reasoning effort matches the difficulty of the request",
  },
  {
    before: "Conversations repeatedly resent large amounts of context",
    after: "Conversations continue efficiently over OpenAI WebSockets",
  },
  {
    before: "Temporary failures could trigger several expensive retries",
    after: "Retries and fallbacks are strictly limited",
  },
  {
    before: "Large models could end up doing routine work",
    after: "Smaller, faster models handle validated routine tasks",
  },
];

const COST_ROWS = [
  { label: "all terra · xhigh", value: "$0.0725" },
  { label: "routed architecture", value: "$0.0314-$0.0319" },
  { label: "savings", value: "56.0-56.7%", strong: true },
];

const SENSITIVITY_ROWS = [
  { label: "same output volume", value: "25-26%" },
  { label: "1.5× output + reasoning", value: "44-45%" },
  { label: "2× output + reasoning", value: "56-57%", strong: true },
];

export default function Iam360CaseStudyPage() {
  return (
    <BlogShell>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />

      <article className="pb-4">
        <CaseStudyHeader study={study} />

        <Prose>
          <Lead>
            <A href={study.website}>iAM360</A> is a fitness and wellness
            platform that helps people understand their wearable, workout,
            nutrition, sleep, and recovery data. Its AI coach turns that
            information into practical answers: how hard to train, when to
            recover, what patterns are affecting progress, and what to do next.
            A connected trainer platform helps coaches manage clients and create
            programs.
          </Lead>
          <P>
            That means the AI handles very different kinds of work. Some
            requests require serious reasoning, such as analyzing weeks of
            health data or building a personalized plan. Others are much
            simpler: identifying the date of a meal photo, classifying a
            message, or returning information in a predefined format.
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="iam360 · routed outcome"
            meta="modeled vs all terra · xhigh"
            footer="representative request · modeled against a hypothetical all terra · xhigh starting point"
          >
            <div className="grid grid-cols-1 divide-y divide-ash-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <StatCell label="lower cost per request">
                <span className="tabular-nums">56-57%</span>
              </StatCell>
              <StatCell label="saved per million requests">
                <span className="tabular-nums">$41,000</span>
              </StatCell>
              <StatCell label="from routing alone, at identical usage">
                <span className="tabular-nums">25-26%</span>
              </StatCell>
            </div>
          </Artifact>
        </Reveal>

        <Prose>
          <H2>The starting point</H2>
          <P>
            Originally, the system was modeled as if every task used
            gpt-5.6-terra with its highest reasoning setting, xhigh. For the
            hardest analysis, that pairing is exactly right. As the default for
            every request, it is expensive precision applied to work that never
            asked for it.
          </P>
          <PullQuote>
            Like hiring a senior specialist to handle everything from strategic
            decisions to routine paperwork: the quality is high, but the cost
            and response time are unnecessarily high.
          </PullQuote>

          <H2>What rightmodeler changed</H2>
          <P>
            Using rightmodeler&rsquo;s routing and evidence framework, iAM360
            taught the system to assign each job to the appropriate level of AI.
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="rightmodeler · routing policy · iam360"
            meta="baseline: terra · xhigh everywhere"
          >
            <RouteRows rows={POLICY} />
          </Artifact>
        </Reveal>

        <Prose>
          <PullQuote>
            We did not remove intelligence. We concentrated it where users
            actually benefit from it.
          </PullQuote>
          <P>
            The counterintuitive part: right-sizing went in both directions.
            Some complex coaching paths were upgraded from Terra to flagship Sol
            at the same time narrowly defined routine tasks moved to smaller,
            faster models. The routing changed more than the models, too:
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact title="what changed" meta="previously modeled → current">
            <div className="divide-y divide-ash-border">
              {CHANGES.map((change) => (
                <div
                  key={change.after}
                  className="grid gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-2"
                >
                  <div className="flex gap-3">
                    <span aria-hidden className="font-mono text-fog">
                      ✕
                    </span>
                    <span className="sr-only">Before:</span>
                    <span className="text-body text-driftwood">
                      {change.before}
                    </span>
                  </div>
                  <div className="flex gap-3">
                    <span aria-hidden className="font-mono text-midnight-ink">
                      ✓
                    </span>
                    <span className="sr-only">After:</span>
                    <span className="text-body text-midnight-ink">
                      {change.after}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Artifact>
        </Reveal>

        <Prose>
          <H2>The modeled savings</H2>
          <P>
            The comparison baseline is a hypothetical starting point where every
            request uses Terra with xhigh reasoning. At identical text usage,
            smarter routing alone reduces the modeled AI cost by approximately
            25 to 26%. The larger saving comes from avoiding excessive reasoning
            on simple tasks.
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="iam360 · modeled cost per call"
            meta="representative request"
          >
            <KVRows rows={COST_ROWS} />
          </Artifact>
        </Reveal>

        <Prose>
          <P>
            In a representative request, the routed system costs approximately
            3.1 cents where the all-Terra xhigh version costs approximately 7.25
            cents: a modeled saving of roughly 56 to 57% per request.
          </P>
          <P>
            The honest caveat is that the headline depends on how much extra
            output and reasoning xhigh actually produces. Even in the most
            conservative case, identical output volume, routing alone still
            saves 25 to 26%:
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="sensitivity · terra-xhigh output multiplier"
            meta="modeled savings"
            footer="the representative request assumes the 2× case, consistent with observed xhigh behavior"
          >
            <KVRows rows={SENSITIVITY_ROWS} />
          </Artifact>
        </Reveal>

        <Prose>
          <H2>What happened to quality?</H2>
          <P>
            The smaller models are not trusted with every request. They are
            assigned narrowly defined tasks with predictable outputs and
            automated validation. The most difficult work still receives a
            flagship model, and some complex paths were upgraded from Terra to
            Sol.
          </P>

          <H2>At scale</H2>
          <P>At the same representative token shape, the savings compound:</P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="iam360 · savings at volume"
            meta="representative token shape"
            footer="modeled at current pricing · scales linearly with volume"
          >
            <div className="grid grid-cols-1 divide-y divide-ash-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <StatCell label="saved per 100,000 requests">
                <span className="tabular-nums">$4,100</span>
              </StatCell>
              <StatCell label="saved per million requests">
                <span className="tabular-nums">$41,000</span>
              </StatCell>
            </div>
          </Artifact>
        </Reveal>

        <Prose>
          <P>
            This is what rightmodeler produces: a routing policy where every job
            runs on the smallest model and reasoning effort that holds its
            quality bar, with the flagship kept, and sometimes promoted, for the
            work that deserves it.
          </P>
          <PullQuote>&ldquo;{study.testimonial.quote}&rdquo;</PullQuote>
          <P>
            <Strong>{study.testimonial.name}</Strong>, {study.testimonial.role}
          </P>
        </Prose>

        <BlogCta />
      </article>
    </BlogShell>
  );
}
