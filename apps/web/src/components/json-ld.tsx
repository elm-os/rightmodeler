// Structured-data helper — renders a schema.org JSON-LD <script> exactly the way the blog routes do
// (see blog/[slug]/page.tsx, blog/page.tsx), so structured data stays consistent across the site.
// `data` is a plain object matching a schema.org type; it is serialised once, server-side.

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
