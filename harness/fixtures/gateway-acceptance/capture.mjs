import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const usage =
  "usage: node capture.mjs --base-url <url> --api-key-env <NAME> --models <A,B> --count <n> --family <name> [--header 'name: value']... [--session-header <name> --session-size <k>] [--family-header <name>] [--extra-body <json>] [--allow-failure] [--out <file.jsonl>]";

const passages = [
  "The library opens at nine in the morning and closes at six in the evening on weekdays.",
  "A light rain fell over the harbor while the ferry waited for its last passengers.",
  "The committee met on Tuesday and agreed to repaint the community hall in the spring.",
  "Fresh bread from the corner bakery usually sells out before noon on Saturdays.",
  "The river rose after a week of storms, but the old stone bridge stayed open to traffic.",
  "Students planted twelve oak saplings along the edge of the school playing field.",
  "The museum added a new gallery of maps that show how the city grew over two centuries.",
  "A local cyclist finished the mountain race in under four hours despite a flat tire.",
  "The town council approved a plan to add benches and shade trees to the main square.",
  "Morning fog delayed several flights, and the airport advised travelers to check their times.",
  "The orchestra rehearsed the new symphony three times before its first public concert.",
  "Volunteers cleaned the beach on Sunday and collected forty bags of washed-up plastic.",
  "The bakery switched to paper bags after customers asked for less plastic packaging.",
  "A small earthquake shook the valley overnight, but no damage or injuries were reported.",
  "The garden club will hold its annual plant sale in the church car park next month.",
  "Engineers replaced the clock tower's worn gears, and the bells now ring on the hour again.",
];

function fail(message) {
  console.error(`capture: ${message}`);
  process.exit(1);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    fail(`--${name} must be a positive integer`);
  }
  return number;
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      models: { type: "string" },
      count: { type: "string" },
      family: { type: "string" },
      header: { type: "string", multiple: true, default: [] },
      "session-header": { type: "string" },
      "session-size": { type: "string" },
      "family-header": { type: "string" },
      "extra-body": { type: "string" },
      "allow-failure": { type: "boolean", default: false },
      out: { type: "string" },
    },
  }));
} catch (error) {
  fail(`${error.message}\n${usage}`);
}

for (const name of ["base-url", "api-key-env", "models", "count", "family"]) {
  if (values[name] === undefined) fail(`--${name} is required\n${usage}`);
}
const apiKey = process.env[values["api-key-env"]];
if (!apiKey) {
  fail(`the environment variable ${values["api-key-env"]} is not set`);
}
const models = values.models.split(",").filter((model) => model.length > 0);
if (models.length === 0) fail("--models must name at least one model");
const count = positiveInteger(values.count, "count");
const family = values.family;
const headers = {};
for (const header of values.header) {
  const colon = header.indexOf(":");
  const name = colon === -1 ? "" : header.slice(0, colon).trim();
  if (name.length === 0) fail("--header must be 'name: value'");
  headers[name] = header.slice(colon + 1).trim();
}
const sessionHeader = values["session-header"];
const sessionSize =
  sessionHeader === undefined
    ? undefined
    : positiveInteger(values["session-size"], "session-size");
let extraBody = {};
if (values["extra-body"] !== undefined) {
  try {
    extraBody = JSON.parse(values["extra-body"]);
  } catch {
    fail("--extra-body must be JSON");
  }
  if (
    typeof extraBody !== "object" ||
    extraBody === null ||
    Array.isArray(extraBody)
  ) {
    fail("--extra-body must be a JSON object");
  }
}

const url = `${values["base-url"].replace(/\/+$/, "")}/chat/completions`;
let sent = 0;
let failed = 0;
for (let index = 0; index < count; index += 1) {
  const model = models[index % models.length];
  const messages = [
    {
      role: "user",
      content: `Summarize in one sentence: ${passages[index % passages.length]}`,
    },
  ];
  const session =
    sessionSize === undefined
      ? undefined
      : `${family}-session-${Math.floor(index / sessionSize)}`;
  const requestHeaders = {
    ...headers,
    ...(session === undefined ? {} : { [sessionHeader]: session }),
    ...(values["family-header"] === undefined
      ? {}
      : { [values["family-header"]]: family }),
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const timestamp = new Date().toISOString();
  const started = performance.now();
  let problem;
  let body;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 64,
        temperature: 0,
        ...extraBody,
      }),
    });
    const text = await response.text();
    if (response.ok) {
      body = JSON.parse(text);
    } else {
      problem = `HTTP ${response.status}: ${text.slice(0, 300)}`;
    }
  } catch (error) {
    problem = error.cause?.message ?? error.message;
  }
  if (problem !== undefined) {
    failed += 1;
    if (!values["allow-failure"]) {
      fail(`call ${index + 1} of ${count} (${model}) failed: ${problem}`);
    }
    continue;
  }
  sent += 1;
  if (values.out !== undefined) {
    await appendFile(
      values.out,
      `${JSON.stringify({
        case_id: session ?? `${family}-${index + 1}`,
        name: family,
        model,
        timestamp,
        messages,
        response: body,
        duration_ms: Math.round(performance.now() - started),
      })}\n`,
    );
  }
}
console.log(JSON.stringify({ sent, failed }));
