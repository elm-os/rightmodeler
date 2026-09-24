// Build gate for the /integrations pages, the counterpart of check-vs.test.mjs. There is no JSON
// Schema here (tsc checks the shape through IntegrationData), so this covers what tsc cannot: every
// data file is named for its slug, stays registered, links a real https site and a real logo,
// points its related row at real pages, and uses a category the hub has a band for. Runs with
// `pnpm test`, so a bad data file fails `pnpm check` before the build.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contentDir = fileURLToPath(
  new URL("../src/content/integrations/", import.meta.url),
);
const dataDir = path.join(contentDir, "data");
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

// The values documented on IntegrationData.category in content/integrations/types.ts.
const CATEGORIES = new Set([
  "trace-source",
  "trace-source-generic",
  "replay-engine",
  "replay-method",
  "execution-backend",
  "evaluator",
  "source-control",
  "ci-recipe",
  "code-context",
  "coming-soon",
]);

const dataFiles = fs
  .readdirSync(dataDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

const readPage = (file) =>
  JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));

test("every integration data file is named for its slug", () => {
  assert.ok(dataFiles.length > 0, "no integration data files found");
  for (const file of dataFiles) {
    assert.equal(
      readPage(file).slug,
      path.basename(file, ".json"),
      `${file}: slug must equal the filename`,
    );
  }
});

test("every data file is registered in content/integrations/index.ts", () => {
  const registry = fs.readFileSync(path.join(contentDir, "index.ts"), "utf8");
  for (const file of dataFiles) {
    assert.ok(
      registry.includes(`data/${file}`),
      `${file} is missing from content/integrations/index.ts, so its page would never build`,
    );
  }
});

test("every website is an https URL", () => {
  for (const file of dataFiles) {
    const { website } = readPage(file);
    assert.ok(
      typeof website === "string" && website.startsWith("https://"),
      `${file}: website must start with https://, got ${JSON.stringify(website)}`,
    );
  }
});

test("every logo is a file under public/", () => {
  for (const file of dataFiles) {
    const { logo } = readPage(file);
    assert.ok(
      typeof logo === "string" &&
        fs
          .statSync(path.join(publicDir, logo), { throwIfNoEntry: false })
          ?.isFile(),
      `${file}: logo ${JSON.stringify(logo)} is not a file under public/`,
    );
  }
});

test("every related slug resolves to an integration page", () => {
  for (const file of dataFiles) {
    for (const slug of readPage(file).related) {
      assert.ok(
        fs.existsSync(path.join(dataDir, `${slug}.json`)),
        `${file}: related slug "${slug}" has no content/integrations/data file, so it would drop silently`,
      );
    }
  }
});

test("every category is a documented value", () => {
  for (const file of dataFiles) {
    const { category } = readPage(file);
    assert.ok(
      CATEGORIES.has(category),
      `${file}: category "${category}" is not documented in content/integrations/types.ts, so no hub band shows it`,
    );
  }
});
