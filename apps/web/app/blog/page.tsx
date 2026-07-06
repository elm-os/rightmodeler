import type { Metadata } from "next";
import { HeroGradient } from "../components/HeroGradient";
import { BlogShell } from "../components/blog/blog_shell";
import { PostCard } from "../components/blog/post_card";
import { Reveal } from "../components/Reveal";
import { getAllPosts } from "./posts";
import { SITE_NAME, SITE_URL } from "../lib/site";

// Parchment legibility veil over the grain-gradient hero — densest behind the top-left masthead copy,
// fading into the gradient toward the bottom-right. Identical to the landing hero (sections/Hero.tsx)
// so the two pages read as one system.
const VEIL =
  "radial-gradient(130% 115% at 24% 30%, rgba(253,252,252,0.82) 0%, rgba(253,252,252,0.34) 46%, rgba(253,252,252,0) 74%)";

const description =
  "Field notes from the rightmodeler team on cutting model cost without giving up the quality you already shipped.";

export const metadata: Metadata = {
  title: "Blog",
  description,
  alternates: { canonical: "/blog" },
  openGraph: {
    type: "website",
    title: `Blog — ${SITE_NAME}`,
    description,
    url: `${SITE_URL}/blog`,
    siteName: SITE_NAME,
  },
  twitter: {
    card: "summary_large_image",
    title: `Blog — ${SITE_NAME}`,
    description,
  },
};

export default function BlogIndexPage() {
  const posts = getAllPosts();

  const blogLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: `${SITE_NAME} blog`,
    url: `${SITE_URL}/blog`,
    description,
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.meta.title,
      description: post.meta.description,
      url: `${SITE_URL}/blog/${post.meta.slug}`,
      datePublished: post.meta.date,
    })),
  };

  return (
    <BlogShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogLd) }}
      />

      <section className="relative isolate overflow-hidden bg-parchment-white">
        {/* Same live grain-gradient shader as the landing hero (sections/Hero.tsx, CtaBand.tsx), so
            the blog masthead reads as one system with the marketing page. The accent hues live only
            in here. */}
        <HeroGradient className="absolute inset-0 -z-10" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: VEIL }}
        />

        <div className="mx-auto max-w-2xl px-6 py-24 sm:px-8 sm:py-32">
          <Reveal>
            <p className="font-mono text-caption text-fog uppercase">
              The rightmodeler blog
            </p>
            <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
              Notes on spending less on models.
            </h1>
            <p className="mt-6 max-w-xl text-subheading text-driftwood">
              How we make multi-agent systems cheaper without giving up the
              quality you already shipped.
            </p>
          </Reveal>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="px-6 py-12 sm:px-8 sm:py-16">
        <div className="mx-auto max-w-5xl space-y-6">
          {posts.map((post, i) => (
            <Reveal key={post.meta.slug} delay={i * 0.06}>
              <PostCard meta={post.meta} />
            </Reveal>
          ))}
        </div>
      </section>
    </BlogShell>
  );
}
