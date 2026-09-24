#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { pathToFileURL } from "node:url";

const valueOptions = new Set(["--assertions", "--model-outputs", "--output"]);
const flagOptions = new Set([
  "--no-write",
  "--no-share",
  "--no-table",
  "--no-progress-bar",
]);

async function readCaptured(file) {
  return readFile(new URL(`captured/${file}`, import.meta.url), "utf8");
}

function parseEvalOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (valueOptions.has(token) && index + 1 < argv.length) {
      options[token] = argv[index + 1];
      index += 1;
    } else if (!flagOptions.has(token)) {
      return { unknown: token };
    }
  }
  return { options };
}

function grade(component, graded) {
  const { type, value } = component.assertion;
  let pass;
  let failure;
  if (type === "equals") {
    pass = graded === value;
    failure = `Expected output "${graded}" to equal "${value}"`;
  } else if (type === "icontains") {
    pass = graded.toLowerCase().includes(value.toLowerCase());
    failure = `Expected output to contain "${value}"`;
  } else {
    throw new Error(`The promptfoo stub cannot grade assertion type ${type}.`);
  }
  return {
    ...component,
    pass,
    score: pass ? 1 : 0,
    reason: pass ? "Assertion passed" : failure,
  };
}

function gradedRow(template, errorTemplate, item, testIdx, fault) {
  const vars = { output: item.output, tags: item.tags.join(", ") };
  if (item.output.startsWith("file://")) {
    const row = structuredClone(errorTemplate);
    return { ...row, testIdx, vars, testCase: { ...row.testCase, vars } };
  }
  const rendered = item.output.replace(/\n$/u, "");
  const graded =
    fault === "rewrite-output" ? `${rendered} [rewritten]` : rendered;
  const row = structuredClone(template);
  const components = row.gradingResult.componentResults.map((component) =>
    grade(component, graded),
  );
  const namedScores = {};
  for (const metric of new Set(
    components.map(({ assertion }) => assertion.metric),
  )) {
    const carrying = components.filter(
      ({ assertion }) => assertion.metric === metric,
    );
    namedScores[metric] =
      carrying.reduce((sum, { score }) => sum + score, 0) / carrying.length;
  }
  const pass = components.every((component) => component.pass);
  const score =
    components.reduce((sum, component) => sum + component.score, 0) /
    components.length;
  const reason = pass
    ? "All assertions passed"
    : components.filter((component) => !component.pass).at(-1).reason;
  return {
    ...row,
    ...(pass ? {} : { error: reason }),
    gradingResult: {
      ...row.gradingResult,
      pass,
      score,
      reason,
      namedScores,
      componentResults: components,
    },
    namedScores,
    prompt: { ...row.prompt, raw: graded },
    promptIdx: 0,
    response: { ...row.response, output: graded, raw: graded },
    score,
    success: pass,
    testCase: { ...row.testCase, vars },
    testIdx,
    vars,
    failureReason: pass ? 0 : 1,
  };
}

async function run() {
  const version = (await readCaptured("version.txt")).trim();
  if (process.argv.includes("--version")) {
    console.log(version);
    return;
  }
  if (process.argv[2] !== "eval") {
    process.stderr.write(`error: unknown command '${process.argv[2]}'\n`);
    process.exitCode = 1;
    return;
  }
  const { options, unknown } = parseEvalOptions(process.argv.slice(3));
  if (unknown !== undefined) {
    process.stderr.write(`error: unknown option '${unknown}'\n`);
    process.exitCode = 1;
    return;
  }
  const fault = process.env.PROMPTFOO_STUB_FAULT;
  if (fault === "read-stdin") await text(process.stdin);
  if (fault === "exit-1") {
    process.stdout.write("stub fault\n");
    process.stderr.write("stub trace\n");
    process.exitCode = 1;
    return;
  }
  const modelOutputs = JSON.parse(
    await readFile(join(process.cwd(), options["--model-outputs"]), "utf8"),
  );
  if (process.env.PROMPTFOO_STUB_RECORD !== undefined) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name.startsWith("PROMPTFOO_") && !name.startsWith("PROMPTFOO_STUB_"),
      ),
    );
    await writeFile(
      process.env.PROMPTFOO_STUB_RECORD,
      JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        env,
        modelOutputs,
      }),
    );
  }
  const failedExitCode = Number(
    process.env.PROMPTFOO_FAILED_TEST_EXIT_CODE ?? 100,
  );
  if (fault === "no-results") {
    process.exitCode = failedExitCode;
    return;
  }
  const captured = JSON.parse(await readCaptured("results.json"));
  const template = captured.results.results.find(
    ({ testIdx }) => testIdx === 0,
  );
  const errorTemplate = captured.results.results.find(
    ({ testIdx }) => testIdx === 4,
  );
  const rows = modelOutputs.map((item, testIdx) =>
    gradedRow(template, errorTemplate, item, testIdx, fault),
  );
  const file = structuredClone(captured);
  file.results.results = rows;
  file.results.stats.successes = rows.filter(
    ({ failureReason }) => failureReason === 0,
  ).length;
  file.results.stats.failures = rows.filter(
    ({ failureReason }) => failureReason === 1,
  ).length;
  file.results.stats.errors = rows.filter(
    ({ failureReason }) => failureReason === 2,
  ).length;
  await writeFile(options["--output"], JSON.stringify(file));
  if (rows.some(({ success }) => !success)) process.exitCode = failedExitCode;
}

async function selftest() {
  const original = process.argv;
  try {
    process.argv = [original[0], original[1], "--version"];
    await run();
    console.log("ok");
  } finally {
    process.argv = original;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--selftest")) await selftest();
  else await run();
}
