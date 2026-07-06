// /blog index card — the whole card is one quiet link. Horizontal on >= sm (hero left, copy right)
// so the index reads well with a single post and scales cleanly to many; stacks on mobile. Hover
// deepens the surface to warm-sand (no accent, per design.md); press gives a subtle scale for
// feedback. Monochrome focus ring. The hero is decorative here, so its alt is empty (the title is
// the accessible link text).

import Image from "next/image";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import type { PostMeta } from "@/content/blog/types";
import { formatPostDate } from "@/lib/site";

export function PostCard({ meta }: { meta: PostMeta }) {
  return (
    <Link
      href={`/blog/${meta.slug}`}
      className="group grid overflow-hidden rounded-xl border border-ash-border bg-parchment-white transition-[transform,background-color] duration-200 ease-out-strong hover:bg-warm-sand active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"
    >
      <div className="overflow-hidden border-b border-ash-border bg-warm-sand sm:border-r sm:border-b-0">
        <Image
          src={meta.hero.src}
          alt=""
          width={1200}
          height={630}
          sizes="(min-width: 640px) 24rem, 100vw"
          className="h-full w-full object-cover"
        />
      </div>

      <div className="flex flex-col p-6 sm:p-8">
        <p className="font-mono text-caption text-fog uppercase">
          {meta.kicker}
        </p>

        <h2 className="mt-3 font-display text-heading-sm text-balance text-midnight-ink sm:text-heading">
          {meta.title}
        </h2>

        <p className="mt-3 text-body text-driftwood">{meta.excerpt}</p>

        <div className="mt-auto flex items-center justify-between gap-4 pt-6">
          <span className="font-mono text-caption text-fog">
            <time dateTime={meta.date}>{formatPostDate(meta.date)}</time> ·{" "}
            {meta.readingMinutes} min read
          </span>
          <ArrowRightIcon className="shrink-0 text-driftwood transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
        </div>
      </div>
    </Link>
  );
}
