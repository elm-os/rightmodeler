"use client";

// Testimonial band: one leadership quote at a time, avatar on top, over a two-logo tab strip.
// The classic customer carousel translated into the house system: monochrome throughout, the
// customer logos as grayscale silhouettes (active near-ink, inactive fog), no progress meter,
// just a slow quiet rotation that pauses while the band is hovered or focused. Clicking a logo
// switches immediately. Under reduced motion there is no auto-rotation and the swap is
// opacity-only. Quotes live in the case-study registry so this band and the articles never drift.

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRightIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { CASE_STUDIES } from "@/content/case-studies";

const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const ROTATE_MS = 8000;

export function TestimonialBand() {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const active = CASE_STUDIES[index];

  // One slow advance per beat. Hover/focus pauses; clicking a tab resets the clock via `index`.
  useEffect(() => {
    if (reduce || paused) return;
    const timer = setTimeout(
      () => setIndex((i) => (i + 1) % CASE_STUDIES.length),
      ROTATE_MS,
    );
    return () => clearTimeout(timer);
  }, [index, paused, reduce]);

  return (
    <section
      className="bg-parchment-white"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPaused(false);
        }
      }}
    >
      <div className="px-6 pt-12 pb-6 sm:px-10 sm:pt-14 sm:pb-8">
        {/* Fixed-height stage so the two quotes swap without the page reflowing. */}
        <Reveal>
          <figure className="mx-auto flex min-h-[17rem] max-w-4xl flex-col items-center justify-center text-center sm:min-h-[15rem]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={active.slug}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: EASE }}
              >
                <Image
                  src={active.testimonial.avatar.src}
                  alt={`${active.testimonial.name} portrait`}
                  width={320}
                  height={320}
                  sizes="3.5rem"
                  className="mx-auto h-12 w-12 rounded-full border border-ash-border object-cover sm:h-14 sm:w-14"
                />

                <blockquote className="mt-6">
                  <p className="font-display text-heading-sm text-balance text-midnight-ink">
                    &ldquo;{active.testimonial.quote}&rdquo;
                  </p>
                </blockquote>

                <figcaption className="mt-5 text-body">
                  <span className="font-medium text-midnight-ink">
                    {active.testimonial.name},
                  </span>{" "}
                  <span className="text-driftwood">
                    {active.testimonial.role}
                  </span>
                </figcaption>

                <div className="mt-5">
                  <Link
                    href={`/case-study/${active.slug}`}
                    className="group inline-flex items-center gap-2 rounded-xl border border-ash-border px-4 py-2.5 text-body text-midnight-ink transition-[background-color,transform] duration-150 ease-out-strong hover:bg-warm-sand active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
                  >
                    Read the story
                    <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </motion.div>
            </AnimatePresence>
          </figure>
        </Reveal>

        {/* Logo tab strip: dotted rule across, silhouettes grey out except the active company. */}
        <Reveal delay={0.06} className="mx-auto mt-6 max-w-4xl sm:mt-8">
          <div className="grid grid-cols-2">
            {CASE_STUDIES.map((study, i) => {
              const isActive = i === index;
              return (
                <button
                  key={study.slug}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-pressed={isActive}
                  aria-label={`Show the ${study.company} testimonial`}
                  className="group relative flex items-center justify-center border-t border-dotted border-ash-border px-4 pt-5 pb-1 transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
                >
                  <Image
                    src={study.logo.src}
                    alt={`${study.company} logo`}
                    width={study.logo.width}
                    height={study.logo.height}
                    sizes="8rem"
                    className={`h-6 w-auto brightness-0 grayscale transition-opacity duration-200 sm:h-7 ${
                      isActive ? "opacity-80" : "opacity-30 hover:opacity-50"
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
