#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function score(output) {
  return output === "Paris" ? 1 : 0.5;
}

async function run() {
  if (process.argv.includes("--version")) {
    console.log("promptfoo-stub 1.0.0");
    return;
  }
  if (process.argv[2] !== "eval") {
    throw new Error("Expected the eval command.");
  }
  const modelOutputsPath = option("--model-outputs");
  const outputPath = option("--output");
  if (modelOutputsPath === undefined || outputPath === undefined) {
    throw new Error("Expected --model-outputs and --output.");
  }
  const outputs = JSON.parse(await readFile(modelOutputsPath, "utf8"));
  await writeFile(
    outputPath,
    JSON.stringify({
      version: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      evalId: "promptfoo-stub-eval",
      results: {
        stats: { successes: 1, failures: 1, errors: 0 },
        prompts: [],
        providers: [],
        outputs: outputs.map((item, testIdx) => {
          const value = score(item.output);
          return {
            testIdx,
            promptIdx: 0,
            success: value === 1,
            score: value,
            response: { output: item.output },
            gradingResult: {
              pass: value === 1,
              score: value,
              reason: value === 1 ? "Exact match" : "Partial match",
              namedScores: {
                output_similarity: value,
                secondary_similarity: value,
              },
              componentResults: [
                {
                  pass: value === 1,
                  score: value,
                  reason: "Deterministic fixture score",
                  assertion: {
                    type: "equals",
                    metric: "output_similarity",
                  },
                  metadata: { rubricVersion: "promptfoo-stub-v1" },
                },
                {
                  pass: value === 1,
                  score: value,
                  reason: "Deterministic fixture score",
                  assertion: {
                    type: "equals",
                    metric: "secondary_similarity",
                  },
                  metadata: { rubricVersion: "promptfoo-stub-v1" },
                },
              ],
            },
          };
        }),
      },
      config: {},
      shareableUrl: null,
    }),
    "utf8",
  );
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
