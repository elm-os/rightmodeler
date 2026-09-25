// Structural gates for the Markdown representation. Filesystem and source-text assertions only,
// in the style of check-vs.test.mjs: the content modules are .tsx importing React components and
// cannot load in plain Node.
//
// The point of these tests is that adding a page and forgetting one of its registration points
// turns the suite red instead of shipping a page agents cannot read.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listFiles, webRoot } from "./check-content.mjs";
import {
  MARKDOWN_HANDLER_BASE,
  markdownHandlerPath,
  markdownSiblingPath,
  STATIC_MARKDOWN_PATHS,
} from "../src/lib/markdown-routes.ts";
import { renderVsMarkdown } from "../src/content/markdown/render-vs.ts";
import { SITE_URL } from "../src/lib/site.ts";

const read = (rel) => fs.readFileSync(path.join(webRoot, rel), "utf8");

// Families resolve from their own registries, so their members never need registering by hand.
const FAMILY_ROUTES = new Set([
  "/blog/[slug]",
  "/vs/[slug]",
  "/integrations/[slug]",
]);

function routesFromFilesystem() {
  return listFiles(path.join(webRoot, "src", "app"), (file) =>
    file.endsWith(`${path.sep}page.tsx`),
  )
    .map((file) => {
      const rel = path.relative(
        path.join(webRoot, "src", "app"),
        path.dirname(file),
      );
      return rel === "" ? "/" : `/${rel.split(path.sep).join("/")}`;
    })
    .filter(
      (route) =>
        !route.split("/").some((s) => s.startsWith("_") || s.startsWith("(")),
    );
}

test("every page in src/app has a Markdown source, by family or by name", () => {
  const known = new Set([...STATIC_MARKDOWN_PATHS, ...FAMILY_ROUTES]);
  const missing = routesFromFilesystem().filter((route) => !known.has(route));
  assert.deepEqual(
    missing,
    [],
    `these routes render HTML but have no Markdown representation. Add each to ` +
      `STATIC_MARKDOWN_PATHS and src/content/pages/index.ts, or give its family a renderer.`,
  );
});

test("every one-off route has a page module wired into the registry", () => {
  const registry = read("src/content/pages/index.ts");
  const families = new Set(["/blog", "/vs", "/integrations", "/case-study"]);
  const missing = STATIC_MARKDOWN_PATHS.filter(
    (route) => !families.has(route) && !registry.includes(`"${route}":`),
  );
  assert.deepEqual(
    missing,
    [],
    "routes absent from PAGE_MARKDOWN in src/content/pages/index.ts",
  );
});

test("every page module the registry names exists and exports non-empty markdown", () => {
  const registry = read("src/content/pages/index.ts");
  const modules = [
    ...registry.matchAll(/from "@\/content\/pages\/([a-z0-9-]+)"/g),
  ].map((m) => m[1]);
  assert.ok(
    modules.length >= 14,
    `expected every one-off page, found ${modules.length}`,
  );
  for (const name of modules) {
    const file = path.join(webRoot, "src", "content", "pages", `${name}.ts`);
    assert.ok(fs.existsSync(file), `src/content/pages/${name}.ts is missing`);
    const source = fs.readFileSync(file, "utf8");
    const body = source.match(/export const markdown = `([\s\S]*)`;?\s*$/);
    assert.ok(
      body,
      `src/content/pages/${name}.ts does not export a markdown template literal`,
    );
    assert.ok(
      body[1].trim().length > 300,
      `${name}.ts markdown is too short to be faithful`,
    );
    assert.equal(
      (body[1].match(/^# /gm) ?? []).length,
      1,
      `${name}.ts must have exactly one h1`,
    );
    // Fenced blocks and inline code spans cannot survive a template literal.
    assert.ok(!body[1].includes("```"), `${name}.ts uses a fenced code block`);
  }
});

test("every marketing route is registered in the sitemap, llms.txt, and the footer", () => {
  const sitemap = read("src/app/sitemap.ts");
  const llms = read("src/lib/llms.ts");
  const footer = read("src/components/sections/footer.tsx");

  // /feedback is deliberately noindex, so the sitemap omits it. The hubs are listed by their own
  // sections rather than in the flat page arrays.
  const SITEMAP_EXEMPT = new Set([
    "/",
    "/feedback",
    "/blog",
    "/vs",
    "/integrations",
  ]);
  const LLMS_EXEMPT = new Set(["/", "/blog"]);

  for (const route of STATIC_MARKDOWN_PATHS) {
    if (!SITEMAP_EXEMPT.has(route)) {
      assert.ok(
        sitemap.includes(`"${route}"`),
        `${route} is missing from sitemap.ts pageEntries`,
      );
    }
    if (!LLMS_EXEMPT.has(route)) {
      assert.ok(
        llms.includes(`"${route}"`),
        `${route} is missing from lib/llms.ts`,
      );
    }
  }
  for (const route of [
    "/how-it-works",
    "/about",
    "/blog",
    "/feedback",
    "/contact",
    "/privacy",
  ]) {
    assert.ok(
      footer.includes(`href="${route}"`),
      `${route} is missing from the footer nav`,
    );
  }
});

test("the .md sibling of every route is rewritten by next.config", () => {
  const config = read("next.config.ts");
  const sources = [...config.matchAll(/source: "(\/[^"]*\.md)"/g)].map(
    (m) => m[1],
  );
  assert.ok(
    sources.includes("/index.md"),
    "the root sibling /index.md has no rewrite",
  );

  const patterns = sources.map(
    (source) =>
      new RegExp(
        `^${source.replace(/:[a-z]/g, "[^/]+").replace(/\./g, "\\.")}$`,
      ),
  );
  for (const route of STATIC_MARKDOWN_PATHS) {
    const sibling = markdownSiblingPath(route);
    assert.ok(
      patterns.some((pattern) => pattern.test(sibling)),
      `${sibling} matches no rewrite source in next.config.ts`,
    );
  }
});

test("markdownSiblingPath and markdownHandlerPath agree on the root", () => {
  assert.equal(markdownSiblingPath("/"), "/index.md");
  assert.equal(markdownHandlerPath("/"), "/md");
  assert.equal(markdownSiblingPath("/about"), "/about.md");
  assert.equal(markdownHandlerPath("/about"), "/md/about");
  // Trailing slashes are normalized away before either mapping.
  assert.equal(markdownHandlerPath("/about/"), "/md/about");
});

test("the proxy matcher skips assets, internals, and the handler it rewrites to", () => {
  const proxy = read("src/proxy.ts");
  const source = proxy.match(/source: "([^"]+)"/)[1].replace(/\\\\/g, "\\");
  const matcher = new RegExp(`^${source}$`);

  for (const excluded of [
    "/_next/static/chunk.js",
    "/_next/image",
    "/_vercel/insights/view",
    "/api/feedback",
    "/md/about",
    "/api/markdown/about",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
    "/llms-context.txt",
    "/manifest.webmanifest",
    "/favicon.ico",
    "/icon.svg",
    "/apple-icon.png",
    "/humans.txt",
    "/about.md",
    "/index.md",
    "/blog/the-tuesday-problem-hero.jpg",
  ]) {
    assert.ok(!matcher.test(excluded), `${excluded} must not invoke the proxy`);
  }

  for (const included of [
    "/",
    "/about",
    "/contact",
    "/blog/the-tuesday-problem",
    "/vs/openrouter",
    "/use-cases/reduce-llm-costs",
    "/nope",
  ]) {
    assert.ok(matcher.test(included), `${included} must be negotiable`);
  }
});

test("the vs renderer handles every block type the schema allows", () => {
  const schema = JSON.parse(read("src/content/vs/vs-page.schema.json"));
  const declared = Object.keys(schema.$defs).filter(
    (name) => schema.$defs[name]?.properties?.type?.const,
  );
  const renderer = read("src/content/markdown/render-vs.ts");
  const handled = new Set(
    [...renderer.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]),
  );
  const missing = declared.filter((name) => !handled.has(name));
  assert.deepEqual(
    missing,
    [],
    "render-vs.ts would silently drop these block types",
  );
});

test("the 404 body points agents at the index files", () => {
  const source = read("src/content/markdown/index.ts");
  for (const target of ["/llms.txt", "/llms-context.txt", "/sitemap.xml"]) {
    assert.ok(
      source.includes(target),
      `the Markdown 404 does not name ${target}`,
    );
  }
});

test("the Markdown handler stays out of /api/, and robots keeps it uncrawlable", () => {
  // Regression guard. When this handler lived at /api/markdown it returned 200 on GET, which
  // readiness scanners read as evidence of a public HTTP API. This site has none, and being
  // judged as though it did activated checks it cannot pass. Keep the rewrite target off /api/
  // and out of the crawl.
  assert.ok(
    !MARKDOWN_HANDLER_BASE.startsWith("/api"),
    `the Markdown handler is at ${MARKDOWN_HANDLER_BASE}; a GET-serving /api/* path reads as a public API`,
  );
  assert.ok(
    !fs.existsSync(path.join(webRoot, "src", "app", "api", "markdown")),
    "src/app/api/markdown still exists",
  );

  const robots = read("src/app/robots.ts");
  for (const prefix of ["/api/", `${MARKDOWN_HANDLER_BASE}/`]) {
    assert.ok(
      robots.includes(`"${prefix}"`),
      `${prefix} is not disallowed in robots.ts`,
    );
  }

  // The public .md siblings must stay crawlable: they are the advertised representation.
  assert.ok(
    !robots.includes('".md"'),
    "the .md siblings must not be disallowed; they are what rel=alternate points at",
  );
});

test("the vs twin spells out scenario verdicts and the hero verdict the way the page does", () => {
  const markdown = renderVsMarkdown(
    {
      name: "Acme",
      h1: "rightmodeler vs Acme",
      lede: "Lede.",
      verdictLabel: "Complement · rightmodeler runs on top",
      website: "https://acme.example",
      blocks: [
        {
          type: "scenarios",
          heading: "Scenarios",
          scenarios: [
            { scenario: "A", winner: "theirs", why: "w" },
            { scenario: "B", winner: "ours", why: "w" },
            { scenario: "C", winner: "both", why: "w" },
          ],
        },
      ],
    },
    SITE_URL,
  );
  assert.doesNotMatch(markdown, /^Use: (?:ours|theirs|both)$/m);
  for (const label of [
    "the right hire: Acme",
    "the right hire: rightmodeler",
    "the right hire: both, together",
  ]) {
    assert.ok(markdown.includes(label), `missing "${label}"`);
  }
  const verdictAt = markdown.indexOf("Complement · rightmodeler runs on top");
  assert.notEqual(verdictAt, -1, "the verdict label is missing");
  assert.ok(
    verdictAt < markdown.indexOf("## Scenarios"),
    "the verdict label must sit under the h1, before the first section",
  );
  assert.ok(
    markdown.includes(
      "Complement · rightmodeler runs on top\n\nOfficial site: https://acme.example\n\n## Scenarios",
    ),
    "the official site line must follow the verdict label, as the hero link follows the chip",
  );
});

test("a comparison with an integration ends its stack section with the setup guide, as the page does", () => {
  const dir = path.join(webRoot, "src", "content", "vs", "data");
  const pages = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
  const stacked = pages.filter(
    (page) =>
      page.integrationSlug &&
      page.blocks.some((block) => block.type === "stack"),
  );
  assert.ok(
    stacked.length > 0,
    "no comparison has both an integrationSlug and a stack block",
  );
  for (const page of pages) {
    const markdown = renderVsMarkdown(page, SITE_URL);
    if (!page.integrationSlug) {
      assert.doesNotMatch(
        markdown,
        /^Setup guide:/m,
        `${page.slug} names no integration but its twin links a setup guide`,
      );
      continue;
    }
    const line = `Setup guide: ${SITE_URL}/integrations/${page.integrationSlug}`;
    // Blocks such as positioning carry no h2, so anchor on the stack's own last line instead of
    // slicing to the next heading: the setup guide must follow it directly.
    for (const block of page.blocks.filter((b) => b.type === "stack")) {
      const last = block.commands?.length
        ? `${block.commands.at(-1).command}\n\`\`\``
        : block.paragraphs.at(-1);
      assert.ok(
        markdown.includes(`${last}\n\n${line}\n`) ||
          markdown.endsWith(`${last}\n\n${line}`),
        `${page.slug}: the stack section must end with "${line}"`,
      );
    }
  }
});
