import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createProgram, executeCli } from "../cli.js";
import { EVALUATOR_POLL_BUDGET_MS } from "./braintrust.js";
import {
  PROMPTFOO_ENV,
  PROMPTFOO_EVAL_FLAGS,
  PROMPTFOO_VERIFIED_VERSION,
} from "./promptfoo.js";

interface Row {
  readonly flag: string;
  readonly requirement: string;
  readonly fallback?: string;
}

const sharedFlags = [
  "--evaluator-scorer",
  "--evaluator-gate-metric",
  "--evaluator-gate-threshold",
];
const documentedDefaults: Record<string, Record<string, string>> = {
  braintrust: {
    "--evaluator-api-key-env": "BRAINTRUST_API_KEY",
    "--evaluator-base-url": "https://api.braintrust.dev",
  },
  langfuse: {
    "--evaluator-api-key-env": "LANGFUSE_SECRET_KEY",
    "--evaluator-base-url": "https://cloud.langfuse.com",
    "--evaluator-public-key-env": "LANGFUSE_PUBLIC_KEY",
  },
  langsmith: {
    "--evaluator-api-key-env": "LANGSMITH_API_KEY",
    "--evaluator-base-url": "https://api.smith.langchain.com",
  },
  promptfoo: { "--evaluator-command": "promptfoo" },
};

const silent = { stdout: () => undefined, stderr: () => undefined };
const replay = createProgram(silent).program.commands.find(
  (command) => command.name() === "replay",
)!;
const providers = replay.options.find(
  (option) => option.long === "--evaluator",
)!.argChoices!;
const providerFlags = replay.options
  .map((option) => option.long ?? "")
  .filter(
    (flag) => flag.startsWith("--evaluator-") && !sharedFlags.includes(flag),
  )
  .sort((left, right) => left.localeCompare(right));
const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
const doc = readFileSync(
  new URL("../../docs/evaluators.md", import.meta.url),
  "utf8",
);
const sandbox = mkdtempSync(join(tmpdir(), "rightmodeler-evaluator-docs-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function docRows(provider: string): Row[] {
  return doc
    .split(`\n### ${provider}\n`)[1]!
    .split(/\n##+ /u)[0]!
    .split("\n")
    .filter((line) => line.startsWith("| `--evaluator-"))
    .map((line): Row => {
      const cells = line
        .split("|")
        .map((cell) => cell.trim().replace(/`/gu, ""));
      const fallback = cells[3]!;
      return {
        flag: cells[1]!.split(" ")[0]!,
        requirement: cells[2]!,
        ...(fallback === "" ? {} : { fallback }),
      };
    })
    .sort((left, right) => left.flag.localeCompare(right.flag));
}

async function usageError(
  argv: readonly string[],
): Promise<{ code: string; message: string }> {
  let stderr = "";
  const exit = await executeCli(
    [
      "--output",
      "json",
      "--repo",
      sandbox,
      "--store",
      sandbox,
      "replay",
      ...argv,
    ],
    {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  expect(exit).toBe(2);
  return JSON.parse(stderr) as { code: string; message: string };
}

describe("evaluator documentation", () => {
  it("documents every provider the CLI accepts", () => {
    expect([...doc.matchAll(/^### (.+)$/gmu)].map((match) => match[1])).toEqual(
      [...providers],
    );
  });

  it("gives every provider one row per provider option", () => {
    for (const provider of providers) {
      expect(docRows(provider).map((row) => row.flag)).toEqual(providerFlags);
    }
    for (const flag of sharedFlags) {
      expect(doc).toContain(`\`${flag} `);
    }
  });

  it("matches the CLI on required, optional, and rejected options", async () => {
    for (const provider of providers) {
      const rows = docRows(provider);
      const required = rows.filter((row) => row.requirement === "required");
      const rejected = rows.filter((row) => row.requirement === "rejected");
      const argv = (skip?: string): string[] => [
        "--evaluator",
        provider,
        "--evaluator-scorer",
        "quality",
        ...required
          .filter((row) => row.flag !== skip)
          .flatMap((row) => [row.flag, "x"]),
      ];
      for (const row of rows) {
        if (row.requirement === "required") {
          const error = await usageError(argv(row.flag));
          expect(error.code).toBe("invalid_option");
          expect(error.message).toContain(row.flag);
        }
        if (row.requirement === "rejected") {
          const error = await usageError([...argv(), row.flag, "x"]);
          expect(error.code).toBe("invalid_option");
          expect(error.message).toMatch(/not used|require/u);
        }
        if (row.requirement === "optional") {
          const error = await usageError([
            ...argv(),
            row.flag,
            "x",
            rejected[0]!.flag,
            "x",
          ]);
          expect(error.code).toBe("invalid_option");
          expect(error.message).not.toContain(row.flag);
        }
      }
    }
  });

  it("documents the defaults the CLI applies", () => {
    for (const provider of providers) {
      const optional = docRows(provider).filter(
        (row) => row.requirement === "optional",
      );
      expect(
        Object.fromEntries(optional.map((row) => [row.flag, row.fallback])),
      ).toEqual(documentedDefaults[provider]);
      for (const row of optional) {
        expect(cliSource).toContain(`"${row.fallback!}"`);
      }
    }
  });

  it("states the polling budget", () => {
    expect(doc).toContain(`up to ${EVALUATOR_POLL_BUDGET_MS / 60_000} minutes`);
  });

  it("states the promptfoo invocation the adapter uses", () => {
    const section = doc.split("\n### promptfoo\n")[1]!.split(/\n## /u)[0]!;
    expect(section).toContain(
      `verified against promptfoo ${PROMPTFOO_VERIFIED_VERSION}`,
    );
    for (const flag of PROMPTFOO_EVAL_FLAGS) expect(section).toContain(flag);
    for (const [name, value] of Object.entries(PROMPTFOO_ENV)) {
      expect(section).toContain(`\`${name}=${value}\``);
    }
    expect(section).toContain("`external_output_mismatch`");
    expect(section).toContain("`external_evaluator_error`");
    expect(section).toContain("`promptfooconfig.*`");
  });
});
