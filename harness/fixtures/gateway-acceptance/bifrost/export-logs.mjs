import { writeFile } from "node:fs/promises";

const usage = "usage: node export-logs.mjs <base-url> <out.jsonl>";
const pageSize = 1000;

function fail(message) {
  console.error(`export-logs: ${message}`);
  process.exit(1);
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    fail(`GET ${url} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

const [baseUrl, out] = process.argv.slice(2);
if (baseUrl === undefined || out === undefined) fail(usage);
const base = baseUrl.replace(/\/+$/, "");

const ids = [];
for (let offset = 0; ; offset += pageSize) {
  const { logs } = await getJson(
    `${base}/api/logs?objects=chat_completion,chat_completion_stream&limit=${pageSize}&offset=${offset}`,
  );
  if (!Array.isArray(logs)) fail("GET /api/logs did not return a logs list");
  ids.push(...logs.map(({ id }) => id));
  if (logs.length < pageSize) break;
}

const lines = [];
for (const id of ids) {
  lines.push(
    JSON.stringify(await getJson(`${base}/api/logs/${encodeURIComponent(id)}`)),
  );
}
await writeFile(out, lines.map((line) => `${line}\n`).join(""));
console.log(JSON.stringify({ exported: lines.length }));
