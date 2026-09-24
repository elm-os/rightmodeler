import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createMatcherRegistry, detectTech, scan } from "@rightmodeler/scanner";
import { describe, expect, it } from "vitest";

import {
  readCodeContext,
  type CodeContext,
  type CodeFinding,
} from "./context.js";
import { renderCodeContext } from "./render.js";

const appPath = fileURLToPath(
  new URL("../../../../fixtures/code-graph-app", import.meta.url),
);
const graphPath = fileURLToPath(
  new URL(
    "../../../../fixtures/code-graph/code-graph-app.graph.json",
    import.meta.url,
  ),
);

async function fixtureContext(revision?: string): Promise<CodeContext> {
  const records = scan(appPath, createMatcherRegistry(), "project");
  const graphCommit = (
    JSON.parse(await readFile(graphPath, "utf8")) as { built_at_commit: string }
  ).built_at_commit;
  const { context } = await readCodeContext({
    graphPath,
    repoDir: appPath,
    revision: revision ?? graphCommit,
    callSites: records.map((record) => ({
      stepId: record.stepId,
      family: record.family,
      path: record.callSite.path,
      line: record.callSite.line,
    })),
    scannedPaths: new Set(records.map(({ callSite }) => callSite.path)),
    sdkModules: detectTech(appPath).aiDependencies,
  });
  return context;
}

describe("renderCodeContext", () => {
  it("renders the disclaimer, one provenance label per finding and the legend", async () => {
    const text = renderCodeContext(await fixtureContext()).join("\n");

    for (const expected of [
      "## Code context (Graphify)",
      "Static code context from a Graphify graph. Graph edges are not replay trials, runtime proof, or quality evidence. They never change a verdict, a gate, confirmation, the proposed swap, or who is asked to review.",
      "| `src/llm.ts:6` in `complete()` | ",
      "| caller (2 hops) | `handleTicket()` | `src/routes/tickets.ts:7` | INFERRED 0.80, verify |",
      "| caller | `summarize()` | `src/summarize.ts:4` | EXTRACTED 1.00 |",
      "| owner, listed only | `@acme/tickets` | `src/routes/tickets.ts` | INFERRED 0.80, verify |",
      "- `src/moderate.ts:1` imports `openai` (EXTRACTED 1.00).",
      "EXTRACTED: explicit in source. INFERRED: resolved by inference, verify before relying on it. AMBIGUOUS: uncertain, verify. A multi-hop finding carries its weakest hop. An enclosing symbol is the nearest definition at or above the call line.",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("gives each provenance its own label", () => {
    const lines = renderCodeContext({
      status: "ok",
      graphPath: "graphify-out/graph.json",
      sha256: "a".repeat(64),
      builtAtCommit: "b".repeat(40),
      revision: "b".repeat(40),
      stale: false,
      nodes: 4,
      edges: 3,
      ignoredNodes: 0,
      ignoredEdges: 0,
      callSites: [
        {
          stepId: "step",
          family: "family",
          path: "src/model.ts",
          line: 2,
          inGraph: true,
          enclosingSymbol: "call()",
          findings: (["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const).map(
            (provenance, index): CodeFinding => ({
              kind: "caller",
              label: `caller${index}()`,
              path: "src/a.ts",
              line: index + 1,
              hops: 1,
              provenance,
              score: 0.5,
            }),
          ),
        },
      ],
      unconfirmedImports: [],
    });
    const rows = lines.filter((line) => line.includes("| caller |"));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/EXTRACTED 0\.50 \|$/);
    expect(rows[1]).toMatch(/INFERRED 0\.50, verify \|$/);
    expect(rows[2]).toMatch(/AMBIGUOUS 0\.50, verify \|$/);
  });

  it("states an unavailable context and a stale graph", async () => {
    const unavailable = renderCodeContext({
      status: "unavailable",
      graphPath: "missing.json",
      reason: "Cannot read the code graph at missing.json (ENOENT).",
    });
    const stale = renderCodeContext(await fixtureContext("0".repeat(40))).join(
      "\n",
    );

    expect(unavailable.at(-1)).toBe(
      "Not shown: Cannot read the code graph at missing.json (ENOENT).",
    );
    expect(stale).toContain("Stale: built at");
    expect(stale).toContain("callers are not shown");
    expect(stale).not.toMatch(/\| caller/);
  });
});
