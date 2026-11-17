import { Reveal } from "@/components/reveal";

// The four shortcuts from docs/positioning.md, in its order. The router card is our opinion and
// carries its three reasons; it never names a product.
const FAILURES: { title: string; body: string }[] = [
  {
    title: "Blind swaps fail quietly.",
    body: "A cheaper model drops into a step in thirty seconds. When it fails, nothing throws: the JSON still parses and is wrong on the edge cases. A user finds out first.",
  },
  {
    title: "Routers don’t work in production.",
    body: "This is our opinion, for three reasons. A runtime router picks a model per request with a policy that was not validated on your workload. It adds a hop and a dependency to the request path. And the same input can take different models, so behavior is harder to reproduce, audit, and roll back. A gateway that serves the model you pin is a different thing.",
  },
  {
    title: "General benchmarks aren’t your workload.",
    body: "A leaderboard ranks models on someone else’s tasks. It can’t tell you whether a cheaper model matches the outputs you already accepted, on your own prompts.",
  },
  {
    title: "Frontier everywhere costs too much.",
    body: "The most expensive model on every step feels safe. Then the bill compounds, call by call, on steps nobody has measured.",
  },
];

// Sits directly above Platform: its closer defines "safe" before Platform's h2 uses the word.
export function ThesisBand() {
  return (
    <section className="bg-parchment-white">
      <div className="px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <p className="font-mono text-caption uppercase text-fog">
            Why model swaps stall
          </p>
          <h2 className="mt-4 max-w-2xl font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            Model maintenance is a standing job.
          </h2>
          <p className="mt-5 max-w-2xl text-subheading text-driftwood">
            For a production AI system, a new model ships every few weeks, and
            each one has to be noticed, replayed on real traces, graded, written
            up, and migrated. That work, not the final call, is the bottleneck:
            the human in the loop spends days on it. Few teams can staff it, so
            model decisions get made one of four ways. In our view, none of them
            holds up.
          </p>
        </Reveal>

        {/* One column: the router card carries three reasons, so a grid would leave holes. */}
        <div className="mt-8 grid gap-3 sm:mt-10 sm:gap-4">
          {FAILURES.map((failure, i) => (
            <Reveal key={failure.title} delay={i * 0.06}>
              <div className="rounded-2xl border border-ash-border bg-parchment-white p-5 sm:p-6 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-baseline md:gap-8">
                <h3 className="font-sans text-heading-sm text-midnight-ink">
                  {failure.title}
                </h3>
                <p className="mt-2 text-body text-driftwood md:mt-0">
                  {failure.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-10 max-w-3xl sm:mt-12">
          <p className="text-heading-sm text-midnight-ink">
            What holds up: one pinned model per step, validated on your own
            traces and changed through code review.
          </p>
          <p className="mt-3 text-body text-driftwood">
            A swap is safe, in rightmodeler&rsquo;s terms, when it clears every
            release gate on your own traces: agreement with the outputs you
            accepted, at a statistical lower bound that reaches your quality
            floor on held-out cases, with swaps that feed later model steps
            confirmed end to end in a sandbox. rightmodeler measures agreement
            with what you shipped, not ground-truth correctness, and abstains
            when the evidence is thin. We are building toward systems that
            maintain and optimize themselves, starting where the evidence can be
            checked.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
