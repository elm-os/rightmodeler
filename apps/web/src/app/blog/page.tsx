import type { Metadata } from "next";
import { BlogShell } from "@/components/blog/blog-shell";
import { PostCard } from "@/components/blog/post-card";
import { HeroGradient } from "@/components/hero-gradient";
import { Reveal } from "@/components/reveal";
import { getAllPosts } from "@/content/blog";
import { BLOG_HUB } from "@/content/markdown/render-hub";
import { alternatesFor, socialImage } from "@/lib/seo";
import { SITE_NAME, SITE_URL } from "@/lib/site";

// Identical to the landing hero's veil (sections/hero.tsx), so the two pages read as one system.
const VEIL =
  "radial-gradient(130% 115% at 24% 30%, rgba(253,252,252,0.82) 0%, rgba(253,252,252,0.34) 46%, rgba(253,252,252,0) 74%)";

const description =
  "Notes from the rightmodeler team on the work in the loop: validating cheaper model swaps on your traces, what a swap has to clear, and what we changed our minds about.";
const preview = socialImage(
  "/social/blog.png",
  "Notes on the work in the loop: the rightmodeler blog",
);

export const metadata: Metadata = {
  title: "Blog",
  description,
  alternates: alternatesFor("/blog"),
  openGraph: {
    type: "website",
    title: `Blog · ${SITE_NAME}`,
    description,
    url: `${SITE_URL}/blog`,
    siteName: SITE_NAME,
    images: [preview],
  },
  twitter: {
    card: "summary_large_image",
    title: `Blog · ${SITE_NAME}`,
    description,
    images: [preview],
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
        <HeroGradient className="absolute inset-0 -z-10" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: VEIL }}
        />

        <div className="mx-auto max-w-2xl px-6 py-24 sm:px-8 sm:py-32">
          <Reveal>
            <p className="font-mono text-caption text-fog uppercase">
              {BLOG_HUB.eyebrow}
            </p>
            <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
              {BLOG_HUB.title}
            </h1>
            <p className="mt-6 max-w-xl text-subheading text-driftwood">
              {BLOG_HUB.lede}
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
