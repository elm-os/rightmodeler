import { readdir, readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const schemaDir = new URL("../schemas/", import.meta.url);
const fixtureDir = new URL("../fixtures/", import.meta.url);
const entries = (await readdir(schemaDir)).filter((file) =>
  file.endsWith(".json"),
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

for (const file of entries) {
  const schema = JSON.parse(await readFile(new URL(file, schemaDir), "utf8"));
  if (!schema.$schema || !schema.title) {
    throw new Error(`${file} is missing $schema or title`);
  }
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`${file} failed to compile: ${error.message}`, {
      cause: error,
    });
  }
  const validFixtureName = file.replace(".schema.json", ".valid.json");
  const invalidFixtureName = file.replace(".schema.json", ".invalid.json");
  const validFixture = JSON.parse(
    await readFile(new URL(validFixtureName, fixtureDir), "utf8"),
  );
  const invalidFixture = JSON.parse(
    await readFile(new URL(invalidFixtureName, fixtureDir), "utf8"),
  );

  if (!validate(validFixture)) {
    throw new Error(
      `${validFixtureName} failed ${file}: ${ajv.errorsText(validate.errors)}`,
    );
  }
  if (validate(invalidFixture)) {
    throw new Error(`${invalidFixtureName} unexpectedly passed ${file}`);
  }
}

console.log(`checked ${entries.length} schema files`);
