import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogShell } from "../../components/blog/blog-shell";
import { PostHeader } from "../../components/blog/post-header";
import { BlogCta } from "../../components/blog/blog-cta";
import { getAllSlugs, getPost } from "../posts";
import { SITE_AUTHOR, SITE_NAME, SITE_URL } from "../../lib/site";

// Prerender every post at build time. Cache Components requires generateStaticParams to return at
// least one param; unknown slugs are handled by notFound() in the page below.
export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

// Every real post is statically prerendered above, so navigating to one is already instant; the only
// non-instant path is the fallback for an unknown slug, which immediately 404s. Opt this segment out
// of Cache Components' instant-navigation validation rather than caching a shell that is never served.
export const instant = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};

  const { meta } = post;
  const url = `${SITE_URL}/blog/${meta.slug}`;
  const author = meta.author ?? SITE_AUTHOR;
  // Keep the brand in the <title> exactly once, even if a headline already contains it.
  const branded = meta.title.toLowerCase().includes(SITE_NAME.toLowerCase())
    ? meta.title
    : `${meta.title} — ${SITE_NAME}`;

  return {
    title: { absolute: branded },
    description: meta.description,
    alternates: { canonical: `/blog/${meta.slug}` },
    openGraph: {
      type: "article",
      title: meta.title,
      description: meta.description,
      url,
      siteName: SITE_NAME,
      publishedTime: meta.date,
      authors: [author],
      images: [
        { url: meta.hero.src, width: 1200, height: 630, alt: meta.hero.alt },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
      images: [meta.hero.src],
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const { meta, Body } = post;
  const url = `${SITE_URL}/blog/${meta.slug}`;
  const author = meta.author ?? SITE_AUTHOR;

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: meta.title,
    description: meta.description,
    image: `${SITE_URL}${meta.hero.src}`,
    datePublished: meta.date,
    dateModified: meta.date,
    author: { "@type": "Organization", name: author },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: "Blog",
        item: `${SITE_URL}/blog`,
      },
      { "@type": "ListItem", position: 3, name: meta.title, item: url },
    ],
  };

  return (
    <BlogShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <article className="pb-4">
        <PostHeader meta={meta} />
        <Body />
        <BlogCta />
      </article>
    </BlogShell>
  );
}
