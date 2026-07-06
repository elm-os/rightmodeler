// Article masthead: a mono kicker, the display title, a mono meta line (byline · date · read time),
// and the framed grain-gradient hero banner. Server component — the hero is a static next/image; the
// copy fades in on load via Reveal (a first-time, page-load moment, so an entrance is earned).

import Image from "next/image";
import { Reveal } from "@/components/reveal";
import type { PostMeta } from "@/content/blog/types";
import { SITE_AUTHOR, formatPostDate } from "@/lib/site";

export function PostHeader({ meta }: { meta: PostMeta }) {
  const author = meta.author ?? SITE_AUTHOR;

  return (
    <header className="pt-16 pb-10 sm:pt-24 sm:pb-14">
      <Reveal className="mx-auto max-w-2xl px-6 sm:px-8">
        <p className="font-mono text-caption text-fog uppercase">
          {meta.kicker}
        </p>

        <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
          {meta.title}
        </h1>

        <p className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-caption text-fog">
          <span className="text-driftwood">{author}</span>
          <span aria-hidden>·</span>
          <time dateTime={meta.date}>{formatPostDate(meta.date)}</time>
          <span aria-hidden>·</span>
          <span>{meta.readingMinutes} min read</span>
        </p>
      </Reveal>

      <Reveal
        delay={0.08}
        className="mx-auto mt-10 max-w-4xl px-6 sm:mt-12 sm:px-8"
      >
        <div className="overflow-hidden rounded-xl border border-ash-border bg-warm-sand">
          <Image
            src={meta.hero.src}
            alt={meta.hero.alt}
            width={1200}
            height={630}
            priority
            sizes="(min-width: 1024px) 56rem, 100vw"
            className="h-auto w-full"
          />
        </div>
      </Reveal>
    </header>
  );
}
