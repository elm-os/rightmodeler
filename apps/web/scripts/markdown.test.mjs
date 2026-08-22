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
  markdownHandlerPath,
  markdownSiblingPath,
  STATIC_MARKDOWN_PATHS,
} from "../src/lib/markdown-routes.ts";

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
  assert.equal(markdownHandlerPath("/"), "/api/markdown");
  assert.equal(markdownSiblingPath("/about"), "/about.md");
  assert.equal(markdownHandlerPath("/about"), "/api/markdown/about");
  // Trailing slashes are normalized away before either mapping.
  assert.equal(markdownHandlerPath("/about/"), "/api/markdown/about");
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
