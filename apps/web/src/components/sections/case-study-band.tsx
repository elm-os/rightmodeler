// Case-study band: the proof block between the platform trio and the closing CTA. Two customer
// stories as full-card links (post-card treatment), each led by its anchor number. Server
// component; data comes from the case-study registry so this band, the /case-study index, and
// the articles never drift.

import { CaseStudyCard } from "@/components/case-study/artifacts";
import { Reveal } from "@/components/reveal";
import { CASE_STUDIES } from "@/content/case-studies";

export function CaseStudyBand() {
  return (
    <section className="bg-parchment-white">
      <div className="px-6 py-16 sm:px-10 sm:py-20">
        <Reveal className="max-w-2xl">
          <p className="font-mono text-caption uppercase text-driftwood">
            Case studies
          </p>
          <h2 className="mt-3 font-display text-heading text-balance text-midnight-ink">
            Right-sizing, in practice.
          </h2>
          <p className="mt-4 text-body text-driftwood">
            Two teams, two stacks, one method: route each workload to the model
            and reasoning effort it needs, and measure that quality holds.
          </p>
        </Reveal>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {CASE_STUDIES.map((study, i) => (
            <Reveal key={study.slug} delay={i * 0.06} className="h-full">
              <CaseStudyCard study={study} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
