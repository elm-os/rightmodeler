// Build gate for the /vs comparison pages: every data file must validate against the JSON Schema
// (content/vs/vs-page.schema.json is the real contract; content/vs/types.ts stays permissive
// because JSON imports widen literals), stay registered, and keep the honesty rule that at least
// one scenario per block names the other tool as the right hire. Runs with `pnpm test` next to
// check-content.test.mjs, so a bad data file fails `pnpm check` before the build.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const contentDir = fileURLToPath(
  new URL("../src/content/vs/", import.meta.url),
);
const dataDir = path.join(contentDir, "data");

const schema = JSON.parse(
  fs.readFileSync(path.join(contentDir, "vs-page.schema.json"), "utf8"),
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
const validate = ajv.compile(schema);

const dataFiles = fs
  .readdirSync(dataDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

const readPage = (file) =>
  JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));

test("schema rejects an empty page and an unknown block type", () => {
  assert.equal(validate({}), false);
  const page = readPage(dataFiles[0]);
  assert.equal(validate({ ...page, blocks: [{ type: "mystery" }] }), false);
});

test("every comparison data file validates against vs-page.schema.json", () => {
  for (const file of dataFiles) {
    const page = readPage(file);
    assert.ok(
      validate(page),
      `${file}: ${ajv.errorsText(validate.errors, { separator: "\n  " })}`,
    );
    assert.equal(
      page.slug,
      path.basename(file, ".json"),
      `${file}: slug must equal the filename`,
    );
  }
});

test("every data file is registered in content/vs/index.ts", () => {
  const registry = fs.readFileSync(path.join(contentDir, "index.ts"), "utf8");
  for (const file of dataFiles) {
    assert.ok(
      registry.includes(`data/${file}`),
      `${file} is missing from content/vs/index.ts, so its page would never build`,
    );
  }
});

test("every scenarios block lets the other tool win at least once", () => {
  for (const file of dataFiles) {
    const page = readPage(file);
    for (const block of page.blocks) {
      if (block.type !== "scenarios") continue;
      assert.ok(
        block.scenarios.some((entry) => entry.winner === "theirs"),
        `${file}: a scenarios block never names ${page.name} as the right hire`,
      );
    }
  }
});
