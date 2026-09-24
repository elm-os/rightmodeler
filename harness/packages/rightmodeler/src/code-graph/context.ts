import { basename } from "node:path";

import { compareText } from "@rightmodeler/core";

import { resolveOwners } from "../enrich/index.js";
import {
  loadCodeGraph,
  provenanceRank,
  type CodeGraphIssue,
  type GraphEdge,
  type GraphNode,
  type GraphProvenance,
} from "./graph.js";

export interface CallSiteInput {
  readonly stepId: string;
  readonly family: string;
  readonly path: string;
  readonly line: number;
}

export type FindingKind = "caller" | "test" | "owner";

export interface CodeFinding {
  readonly kind: FindingKind;
  readonly label: string;
  readonly path: string;
  readonly line: number | null;
  readonly hops: number;
  readonly provenance: GraphProvenance;
  readonly score: number;
}

export interface CallSiteContext {
  readonly stepId: string;
  readonly family: string;
  readonly path: string;
  readonly line: number;
  readonly inGraph: boolean;
  readonly enclosingSymbol: string | null;
  readonly findings: readonly CodeFinding[];
}

export interface UnconfirmedImport {
  readonly path: string;
  readonly line: number | null;
  readonly module: string;
  readonly provenance: GraphProvenance;
  readonly score: number;
}

export type CodeContext =
  | {
      readonly status: "unavailable";
      readonly graphPath: string;
      readonly reason: string;
    }
  | {
      readonly status: "ok";
      readonly graphPath: string;
      readonly sha256: string;
      readonly builtAtCommit: string | null;
      readonly revision: string;
      readonly stale: boolean;
      readonly nodes: number;
      readonly edges: number;
      readonly ignoredNodes: number;
      readonly ignoredEdges: number;
      readonly callSites: readonly CallSiteContext[];
      readonly unconfirmedImports: readonly UnconfirmedImport[];
    };

const CALLER_RELATIONS = new Set(["calls", "indirect_call"]);
const CALLER_DEPTH = 2;
const TEST_RELATIONS = new Set([
  "calls",
  "indirect_call",
  "references",
  "imports",
  "imports_from",
  "dynamic_import",
  "re_exports",
  "inherits",
  "extends",
  "implements",
  "uses",
  "mixes_in",
  "embeds",
  "requires",
  "contains",
  "method",
]);
const TEST_DEPTH = 3;
const IMPORT_RELATIONS = new Set([
  "imports",
  "imports_from",
  "dynamic_import",
  "re_exports",
]);
const TEST_PATH =
  /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const MANIFEST_PATH =
  /(^|\/)(package\.json|pyproject\.toml|requirements\.txt)$/;
const KIND_ORDER: Record<FindingKind, number> = {
  caller: 0,
  test: 1,
  owner: 2,
};

interface Hit {
  readonly node: GraphNode;
  readonly hops: number;
  readonly provenance: GraphProvenance;
  readonly score: number;
  readonly path: string | null;
  readonly line: number | null;
}

function weaker(
  left: GraphProvenance,
  right: GraphProvenance,
): GraphProvenance {
  return provenanceRank[left] <= provenanceRank[right] ? left : right;
}

function stronger(left: CodeFinding, right: CodeFinding): boolean {
  return (
    (provenanceRank[left.provenance] - provenanceRank[right.provenance] ||
      left.score - right.score ||
      right.hops - left.hops ||
      compareText(right.path, left.path)) > 0
  );
}

function walk(
  seed: GraphNode,
  nodes: ReadonlyMap<string, GraphNode>,
  incoming: ReadonlyMap<string, readonly GraphEdge[]>,
  relations: ReadonlySet<string>,
  depth: number,
): Hit[] {
  const visited = new Set([seed.id]);
  const hits: Hit[] = [];
  let frontier: Array<{
    id: string;
    provenance: GraphProvenance;
    score: number;
  }> = [{ id: seed.id, provenance: "EXTRACTED", score: 1 }];
  for (let hops = 1; hops <= depth && frontier.length > 0; hops += 1) {
    const next: typeof frontier = [];
    for (const parent of frontier) {
      for (const edge of incoming.get(parent.id) ?? []) {
        if (!relations.has(edge.relation) || visited.has(edge.source)) {
          continue;
        }
        visited.add(edge.source);
        const node = nodes.get(edge.source)!;
        const provenance = weaker(parent.provenance, edge.provenance);
        const score = Math.min(parent.score, edge.score);
        hits.push({
          node,
          hops,
          provenance,
          score,
          path: edge.path ?? node.path,
          line: edge.line,
        });
        next.push({ id: node.id, provenance, score });
      }
    }
    frontier = next;
  }
  return hits;
}

function compareFindings(left: CodeFinding, right: CodeFinding): number {
  return (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    left.hops - right.hops ||
    compareText(left.path, right.path) ||
    compareLines(left.line, right.line) ||
    compareText(left.label, right.label)
  );
}

function compareLines(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function graphifyId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function readCodeContext(input: {
  readonly graphPath: string;
  readonly repoDir: string;
  readonly revision: string;
  readonly callSites: readonly CallSiteInput[];
  readonly scannedPaths: ReadonlySet<string>;
  readonly sdkModules: readonly {
    readonly language: "javascript" | "python";
    readonly name: string;
  }[];
}): Promise<{
  readonly context: CodeContext;
  readonly issues: readonly CodeGraphIssue[];
}> {
  const loaded = await loadCodeGraph(input.graphPath, input.repoDir);
  if ("issue" in loaded) {
    return {
      context: {
        status: "unavailable",
        graphPath: loaded.displayPath,
        reason: loaded.issue.message,
      },
      issues: [loaded.issue],
    };
  }
  const { graph } = loaded;
  const issues = [...loaded.issues];

  const nodesByPath = new Map<string, GraphNode[]>();
  for (const node of graph.nodes.values()) {
    if (node.path !== null) append(nodesByPath, node.path, node);
  }
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) append(incoming, edge.target, edge);
  for (const edges of incoming.values()) {
    edges.sort(
      (left, right) =>
        compareText(left.source, right.source) ||
        compareText(left.relation, right.relation),
    );
  }

  const callSitePaths = new Set(input.callSites.map(({ path }) => path));
  if (
    callSitePaths.size > 0 &&
    ![...callSitePaths].some((path) => nodesByPath.has(path))
  ) {
    const issue = {
      code: "code_graph_repo_mismatch",
      message: `None of the ${callSitePaths.size} scanned call-site files appear in the code graph at ${graph.displayPath}, so it describes another repository or folder. Code context is omitted. Build the graph from the repository root with \`graphify update .\`.`,
    };
    return {
      context: {
        status: "unavailable",
        graphPath: graph.displayPath,
        reason: issue.message,
      },
      issues: [...issues, issue],
    };
  }

  const stale = graph.builtAtCommit !== input.revision;
  if (stale) {
    issues.push({
      code: "code_graph_stale",
      message: `The code graph was built at ${graph.builtAtCommit?.slice(0, 12) ?? "an unrecorded commit"} but the scan is at ${input.revision.slice(0, 12)}, so code context is file-level only. Rebuild with \`graphify update .\` at the scanned commit, or rerun the scan.`,
    });
  }

  const callSites: CallSiteContext[] = [];
  for (const callSite of input.callSites) {
    const inPath = nodesByPath.get(callSite.path);
    if (inPath === undefined) {
      callSites.push({
        ...callSite,
        inGraph: false,
        enclosingSymbol: null,
        findings: [],
      });
      continue;
    }
    const fileNode = inPath.find(
      ({ label }) => label === basename(callSite.path),
    );
    const enclosing = stale
      ? undefined
      : inPath
          .filter(
            (node) =>
              node !== fileNode &&
              node.line !== null &&
              node.line <= callSite.line,
          )
          .sort(
            (left, right) =>
              right.line! - left.line! || compareText(left.id, right.id),
          )[0];
    const seed = enclosing ?? fileNode;

    const findings: CodeFinding[] = [];
    const hitFinding = (kind: FindingKind, label: string, hit: Hit) => {
      if (hit.path === null) return;
      findings.push({
        kind,
        label,
        path: hit.path,
        line: hit.line,
        hops: hit.hops,
        provenance: hit.provenance,
        score: hit.score,
      });
    };
    if (enclosing !== undefined) {
      for (const hit of walk(
        enclosing,
        graph.nodes,
        incoming,
        CALLER_RELATIONS,
        CALLER_DEPTH,
      )) {
        hitFinding("caller", hit.node.label, hit);
      }
    }
    if (seed !== undefined) {
      const testFiles = new Set<string>();
      for (const hit of walk(
        seed,
        graph.nodes,
        incoming,
        TEST_RELATIONS,
        TEST_DEPTH,
      )) {
        const file = hit.node.path;
        if (file === null || !TEST_PATH.test(file) || testFiles.has(file)) {
          continue;
        }
        testFiles.add(file);
        hitFinding("test", file, { ...hit, path: file });
      }
    }

    const surfaced = [...new Set(findings.map(({ path }) => path))];
    if (surfaced.length > 0) {
      const resolutions = await resolveOwners({
        repoDir: input.repoDir,
        filePaths: surfaced,
      });
      const strongest = new Map<string, CodeFinding>();
      resolutions.forEach(({ owners }, index) => {
        const sources = findings.filter(({ path }) => path === surfaced[index]);
        for (const { handle } of owners) {
          for (const source of sources) {
            const current = strongest.get(handle);
            if (current === undefined || stronger(source, current)) {
              strongest.set(handle, source);
            }
          }
        }
      });
      for (const [handle, source] of strongest) {
        findings.push({
          kind: "owner",
          label: handle,
          path: source.path,
          line: null,
          hops: source.hops,
          provenance: source.provenance,
          score: source.score,
        });
      }
    }

    callSites.push({
      ...callSite,
      inGraph: true,
      enclosingSymbol: enclosing?.label ?? null,
      findings: findings.sort(compareFindings),
    });
  }

  const jsIds = new Set(
    input.sdkModules
      .filter(({ language }) => language === "javascript")
      .map(({ name }) => `ref_${graphifyId(name)}`),
  );
  const pythonIds = input.sdkModules
    .filter(({ language }) => language === "python")
    .map(({ name }) => graphifyId(name));
  const imports = new Map<string, UnconfirmedImport>();
  for (const edge of graph.edges) {
    const target = graph.nodes.get(edge.target)!;
    if (
      !IMPORT_RELATIONS.has(edge.relation) ||
      target.fileType !== "concept" ||
      !(
        jsIds.has(target.id) ||
        pythonIds.some(
          (id) => target.id === id || target.id.startsWith(`${id}_`),
        )
      ) ||
      edge.path === null ||
      MANIFEST_PATH.test(edge.path) ||
      TEST_PATH.test(edge.path) ||
      input.scannedPaths.has(edge.path)
    ) {
      continue;
    }
    const key = `${edge.path}\u0000${target.label}`;
    const current = imports.get(key);
    if (current === undefined || compareLines(edge.line, current.line) < 0) {
      imports.set(key, {
        path: edge.path,
        line: edge.line,
        module: target.label,
        provenance: edge.provenance,
        score: edge.score,
      });
    }
  }

  return {
    context: {
      status: "ok",
      graphPath: graph.displayPath,
      sha256: graph.sha256,
      builtAtCommit: graph.builtAtCommit,
      revision: input.revision,
      stale,
      nodes: graph.nodes.size,
      edges: graph.edges.length,
      ignoredNodes: graph.ignoredNodes,
      ignoredEdges: graph.ignoredEdges,
      callSites,
      unconfirmedImports: [...imports.values()].sort(
        (left, right) =>
          compareText(left.path, right.path) ||
          compareLines(left.line, right.line),
      ),
    },
    issues,
  };
}
