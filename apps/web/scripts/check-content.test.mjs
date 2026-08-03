import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  findBlogParityViolation,
  findEmDashViolations,
  findProductFactHardcodes,
  listFiles,
  readProductFacts,
  webRoot,
} from "./check-content.mjs";

const emDash = String.fromCodePoint(0x2014);

test("visible-copy check ignores an em dash in a JSX comment", () => {
  const source = `export function Example() {
    return <p>{/* comment ${emDash} only */}Visible copy.</p>;
  }`;
  assert.deepEqual(findEmDashViolations(source, "comment.tsx"), []);
});

test("visible-copy check fails on a seeded em dash in JSX text", () => {
  const source = `export function Example() {
    return <p>Visible ${emDash} copy.</p>;
  }`;
  assert.equal(findEmDashViolations(source, "visible.tsx").length, 1);
});

test("visible-copy check scans Markdown and ignores Markdown comments", () => {
  const source = `<!-- comment ${emDash} only -->
Visible ${emDash} copy.`;
  assert.equal(findEmDashViolations(source, "visible.md").length, 1);
});

test("blog parity check fails on a seeded substantive divergence", () => {
  const source = `export const meta = { title: "Example" };
  export function Body() {
    return <article><p>Same body.</p></article>;
  }
  export const markdown = \`# Example

  Different body.
  \`;`;
  assert.ok(findBlogParityViolation(source, "post.tsx"));
});

test("blog parity preserves underscores inside identifiers", () => {
  const source = `export const meta = { title: "Example" };
  export function Body() {
    return <article><p>qualityfloor</p></article>;
  }
  export const markdown = \`# Example

  quality_floor
  \`;`;
  assert.ok(findBlogParityViolation(source, "post.tsx"));
});

test("blog parity fails closed on self-closing custom components", () => {
  const source = `export const meta = { title: "Example" };
  export function Body() {
    return <article><Callout text="Visible claim." /></article>;
  }
  export const markdown = \`# Example

  Visible claim.
  \`;`;
  assert.throws(
    () => findBlogParityViolation(source, "post.tsx"),
    /unsupported self-closing component/,
  );
});

test("web surfaces use product-facts constants for shared counts and scores", () => {
  const factsPath = path.join(webRoot, "src", "lib", "product-facts.ts");
  const facts = readProductFacts(fs.readFileSync(factsPath, "utf8"), factsPath);
  const surfaceFiles = listFiles(
    path.join(webRoot, "src"),
    (filePath) =>
      (filePath.endsWith(".tsx") || filePath.endsWith(".json")) &&
      !filePath.includes(`${path.sep}case-study${path.sep}`),
  );
  const violations = surfaceFiles.flatMap((filePath) =>
    findProductFactHardcodes(
      fs.readFileSync(filePath, "utf8"),
      filePath,
      filePath.endsWith(".json") ? { ...facts, scores: [] } : facts,
    ),
  );

  assert.deepEqual(
    violations.map((violation) => ({
      file: path.relative(webRoot, violation.filePath),
      line: violation.line,
      value: violation.value,
    })),
    [],
  );
});
