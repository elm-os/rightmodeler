import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createMatcherRegistry, detectTech, scan } from "@rightmodeler/scanner";
import { describe, expect, it } from "vitest";

import { readCodeContext, type CallSiteInput } from "./context.js";

const appPath = fileURLToPath(
  new URL("../../../../fixtures/code-graph-app", import.meta.url),
);
const graphPath = fileURLToPath(
  new URL(
    "../../../../fixtures/code-graph/code-graph-app.graph.json",
    import.meta.url,
  ),
);

async function fixtureInput() {
  const records = scan(appPath, createMatcherRegistry(), "project");
  const callSites = records.map((record) => ({
    stepId: record.stepId,
    family: record.family,
    path: record.callSite.path,
    line: record.callSite.line,
  }));
  const graphCommit = (
    JSON.parse(await readFile(graphPath, "utf8")) as { built_at_commit: string }
  ).built_at_commit;
  return {
    graphPath,
    repoDir: appPath,
    revision: graphCommit,
    callSites,
    scannedPaths: new Set(records.map(({ callSite }) => callSite.path)),
    sdkModules: detectTech(appPath).aiDependencies,
  };
}

function okContext(
  result: Awaited<ReturnType<typeof readCodeContext>>,
): Extract<(typeof result)["context"], { status: "ok" }> {
  if (result.context.status !== "ok") throw new Error(result.context.reason);
  return result.context;
}

describe("readCodeContext", () => {
  it("resolves callers, tests and owners with weakest-hop provenance", async () => {
    const result = await readCodeContext(await fixtureInput());
    const context = okContext(result);

    expect(result.issues).toEqual([]);
    expect(context.callSites).toHaveLength(1);
    expect(context.callSites[0]).toMatchObject({
      path: "src/llm.ts",
      line: 6,
      inGraph: true,
      enclosingSymbol: "complete()",
    });
    expect(context.callSites[0]!.findings).toEqual([
      {
        kind: "caller",
        label: ".classify()",
        path: "src/llm.ts",
        line: 15,
        hops: 1,
        provenance: "EXTRACTED",
        score: 1,
      },
      {
        kind: "caller",
        label: "summarize()",
        path: "src/summarize.ts",
        line: 4,
        hops: 1,
        provenance: "EXTRACTED",
        score: 1,
      },
      {
        kind: "caller",
        label: "summarizeAll()",
        path: "src/batch.ts",
        line: 4,
        hops: 2,
        provenance: "INFERRED",
        score: 0.85,
      },
      {
        kind: "caller",
        label: "handleTicket()",
        path: "src/routes/tickets.ts",
        line: 7,
        hops: 2,
        provenance: "INFERRED",
        score: 0.8,
      },
      {
        kind: "test",
        label: "tests/summarize.test.ts",
        path: "tests/summarize.test.ts",
        line: 3,
        hops: 2,
        provenance: "EXTRACTED",
        score: 1,
      },
      {
        kind: "owner",
        label: "@acme/platform",
        path: "src/llm.ts",
        line: null,
        hops: 1,
        provenance: "EXTRACTED",
        score: 1,
      },
      {
        kind: "owner",
        label: "@acme/tickets",
        path: "src/routes/tickets.ts",
        line: null,
        hops: 2,
        provenance: "INFERRED",
        score: 0.8,
      },
      {
        kind: "owner",
        label: "@acme/qa",
        path: "tests/summarize.test.ts",
        line: null,
        hops: 2,
        provenance: "EXTRACTED",
        score: 1,
      },
    ]);
  });

  it("lists an SDK import without a scanner call site as unconfirmed and never as a call site", async () => {
    const context = okContext(await readCodeContext(await fixtureInput()));

    expect(context.unconfirmedImports).toEqual([
      {
        path: "src/moderate.ts",
        line: 1,
        module: "openai",
        provenance: "EXTRACTED",
        score: 1,
      },
    ]);
    expect(context.callSites.map(({ path }) => path)).toEqual(["src/llm.ts"]);
  });

  it("falls back to file-level context with a stale graph", async () => {
    const result = await readCodeContext({
      ...(await fixtureInput()),
      revision: "0".repeat(40),
    });
    const context = okContext(result);
    const findings = context.callSites[0]!.findings;

    expect(context.stale).toBe(true);
    expect(context.callSites[0]!.enclosingSymbol).toBeNull();
    expect(findings.filter(({ kind }) => kind === "caller")).toEqual([]);
    expect(findings.filter(({ kind }) => kind === "test")).toMatchObject([
      { path: "tests/summarize.test.ts" },
    ]);
    expect(
      findings.filter(({ kind }) => kind === "owner").map(({ label }) => label),
    ).toEqual(["@acme/qa"]);
    expect(result.issues.map(({ code }) => code)).toEqual(["code_graph_stale"]);
  });

  it("omits the context with one warning when the graph describes another repository", async () => {
    const result = await readCodeContext({
      ...(await fixtureInput()),
      callSites: [
        { stepId: "x", family: "f", path: "app/actions.ts", line: 6 },
      ],
    });

    expect(result.context.status).toBe("unavailable");
    expect(result.issues.map(({ code }) => code)).toEqual([
      "code_graph_repo_mismatch",
    ]);
  });

  it("marks a call site whose file the graph does not contain", async () => {
    const input = await fixtureInput();
    const outside: CallSiteInput = {
      stepId: "y",
      family: "f",
      path: "README.md",
      line: 1,
    };
    const result = await readCodeContext({
      ...input,
      callSites: [...input.callSites, outside],
    });
    const context = okContext(result);

    expect(result.issues).toEqual([]);
    expect(context.callSites.at(-1)).toEqual({
      ...outside,
      inGraph: false,
      enclosingSymbol: null,
      findings: [],
    });
  });
});
