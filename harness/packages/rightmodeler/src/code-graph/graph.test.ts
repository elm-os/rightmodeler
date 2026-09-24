import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { graphFileDigest, loadCodeGraph } from "./graph.js";

const capturePath = fileURLToPath(
  new URL(
    "../../../../fixtures/code-graph/code-graph-app.graph.json",
    import.meta.url,
  ),
);
const appPath = fileURLToPath(
  new URL("../../../../fixtures/code-graph-app", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface RawGraph {
  built_at_commit?: string;
  nodes: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
}

async function readCapture(): Promise<RawGraph> {
  return JSON.parse(await readFile(capturePath, "utf8")) as RawGraph;
}

async function writeGraph(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-code-graph-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "graph.json");
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return path;
}

async function loaded(path: string) {
  const result = await loadCodeGraph(path, appPath);
  if (!("graph" in result)) throw new Error(result.issue.message);
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadCodeGraph", () => {
  it("reads the real Graphify 0.9.65 capture with its provenance, scores and commit", async () => {
    const capture = await readCapture();
    const { graph, issues } = await loaded(capturePath);

    expect(graph.nodes.size).toBe(23);
    expect(graph.edges).toHaveLength(30);
    expect(graph.ignoredNodes).toBe(0);
    expect(graph.ignoredEdges).toBe(0);
    expect(issues).toEqual([]);
    expect(graph.builtAtCommit).toBe(capture.built_at_commit);
    expect(graph.sha256).toBe(
      createHash("sha256")
        .update(await readFile(capturePath))
        .digest("hex"),
    );
    expect(
      graph.edges.find(
        ({ source, target }) =>
          source === "src_routes_tickets_handleticket" &&
          target === "src_llm_ticketmodel_classify",
      ),
    ).toMatchObject({
      provenance: "INFERRED",
      score: 0.8,
      path: "src/routes/tickets.ts",
      line: 7,
    });
    expect(
      graph.edges.find(({ source }) => source === "src_batch_summarizeall"),
    ).toMatchObject({
      relation: "indirect_call",
      provenance: "INFERRED",
      score: 0.85,
    });
    expect(graph.nodes.get("src_llm_complete")).toMatchObject({
      label: "complete()",
      path: "src/llm.ts",
      line: 5,
    });
  });

  it("reads a graph from an older Graphify that kept direction in _src and _tgt", async () => {
    const capture = await readCapture();
    const { built_at_commit: _commit, ...legacy } = capture;
    legacy.links = capture.links.map(
      ({ source, target, confidence_score: _score, ...link }) => ({
        ...link,
        _src: source,
        _tgt: target,
        source: target,
        target: source,
      }),
    );
    const { graph, issues } = await loaded(await writeGraph(legacy));

    expect(issues).toEqual([]);
    expect(graph.builtAtCommit).toBeNull();
    expect(
      graph.edges.map(({ source, target }) => ({ source, target })),
    ).toEqual(capture.links.map(({ source, target }) => ({ source, target })));
    expect(
      graph.edges.map(({ provenance, score }) => ({ provenance, score })),
    ).toEqual(
      capture.links.map(({ confidence }) => ({
        provenance: confidence,
        score: confidence === "INFERRED" ? 0.55 : 1,
      })),
    );
  });

  it("ignores what it cannot read and reports the drift once", async () => {
    const capture = await readCapture();
    capture.links[0] = { ...capture.links[0], confidence: "PROBABLE" };
    capture.nodes.push({ label: "no id" });
    const { graph, issues } = await loaded(await writeGraph(capture));

    expect(graph.edges).toHaveLength(29);
    expect(graph.ignoredEdges).toBe(1);
    expect(graph.ignoredNodes).toBe(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "code_graph_schema_drift" });
    expect(issues[0]!.message).toContain("PROBABLE");
  });

  it("names an unreadable path, a non-graph file and an oversized file without throwing", async () => {
    const missing = join(appPath, "missing.graph.json");
    const notJson = await writeGraph("not json");
    const noLinks = await writeGraph('{"nodes": []}');
    const oversized = await writeGraph("");
    await truncate(oversized, constants.MAX_STRING_LENGTH + 1);

    await expect(loadCodeGraph(missing, appPath)).resolves.toMatchObject({
      issue: { code: "code_graph_unreadable" },
    });
    await expect(loadCodeGraph(notJson, tmpdir())).resolves.toMatchObject({
      issue: { code: "code_graph_invalid" },
    });
    await expect(loadCodeGraph(noLinks, tmpdir())).resolves.toMatchObject({
      issue: { code: "code_graph_invalid" },
    });
    await expect(loadCodeGraph(oversized, tmpdir())).resolves.toMatchObject({
      issue: { code: "code_graph_too_large" },
    });
    await expect(graphFileDigest(missing)).resolves.toBe("unreadable");
    await expect(graphFileDigest(oversized)).resolves.toMatch(/^too-large:/);
    await expect(graphFileDigest(capturePath)).resolves.toBe(
      createHash("sha256")
        .update(await readFile(capturePath))
        .digest("hex"),
    );
  });
});
