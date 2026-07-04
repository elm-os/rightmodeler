import { readdir, readFile } from "node:fs/promises";

const schemaDir = new URL("../schemas/", import.meta.url);
const entries = (await readdir(schemaDir)).filter((file) =>
  file.endsWith(".json"),
);

for (const file of entries) {
  const payload = JSON.parse(await readFile(new URL(file, schemaDir), "utf8"));
  if (!payload.$schema || !payload.title) {
    throw new Error(`${file} is missing $schema or title`);
  }
}

console.log(`checked ${entries.length} schema files`);
