import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { z } from "zod";

export type GraphProvenance = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export const provenanceRank = {
  AMBIGUOUS: 0,
  INFERRED: 1,
  EXTRACTED: 2,
} as const satisfies Record<GraphProvenance, number>;

const tierScores = {
  EXTRACTED: 1,
  INFERRED: 0.55,
  AMBIGUOUS: 0.2,
} as const satisfies Record<GraphProvenance, number>;

export interface CodeGraphIssue {
  readonly code: string;
  readonly message: string;
}

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly fileType: string | null;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  readonly provenance: GraphProvenance;
  readonly score: number;
  readonly path: string | null;
  readonly line: number | null;
}

export interface CodeGraph {
  readonly displayPath: string;
  readonly sha256: string;
  readonly builtAtCommit: string | null;
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly ignoredNodes: number;
  readonly ignoredEdges: number;
}

const locationSchema = z.union([z.string(), z.number()]).nullable().optional();

const fileSchema = z.looseObject({
  nodes: z.array(z.unknown()),
  links: z.array(z.unknown()).optional(),
  edges: z.array(z.unknown()).optional(),
  built_at_commit: z.string().min(1).optional().catch(undefined),
});

const nodeSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string().optional(),
  file_type: z.string().optional(),
  source_file: z.string().nullable().optional(),
  source_location: locationSchema,
});

const edgeSchema = z.looseObject({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.string().min(1),
  _src: z.string().min(1).optional(),
  _tgt: z.string().min(1).optional(),
  confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]),
  confidence_score: z.number().optional(),
  source_file: z.string().nullable().optional(),
  source_location: locationSchema,
});

export async function graphFileDigest(path: string): Promise<string> {
  try {
    const { size } = await stat(path);
    if (size > constants.MAX_STRING_LENGTH) return `too-large:${size}`;
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return "unreadable";
  }
}

export async function loadCodeGraph(
  path: string,
  repoDir: string,
): Promise<
  | { readonly graph: CodeGraph; readonly issues: readonly CodeGraphIssue[] }
  | { readonly issue: CodeGraphIssue; readonly displayPath: string }
> {
  const fromRepo = relative(repoDir, path).split(sep).join("/");
  const displayPath = fromRepo.startsWith("..") ? path : fromRepo;
  const unreadable = (error: unknown) => ({
    displayPath,
    issue: {
      code: "code_graph_unreadable",
      message: `Cannot read the code graph at ${displayPath} (${errorCode(error)}). Code context is omitted. Check the --code-graph path, or rebuild the graph with \`graphify update .\`.`,
    },
  });
  const invalid = (reason: string) => ({
    displayPath,
    issue: {
      code: "code_graph_invalid",
      message: `${displayPath} is not a Graphify graph.json (${reason}). Code context is omitted. Pass the graph.json that \`graphify update .\` writes under graphify-out/.`,
    },
  });

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    return unreadable(error);
  }
  if (size > constants.MAX_STRING_LENGTH) {
    return {
      displayPath,
      issue: {
        code: "code_graph_too_large",
        message: `The code graph at ${displayPath} is ${size} bytes, over the ${constants.MAX_STRING_LENGTH}-byte limit Node.js can read. Code context is omitted. Narrow the graph with a .graphifyignore and rebuild it with \`graphify update .\`.`,
      },
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    return unreadable(error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalid("not JSON");
  }
  const file = fileSchema.safeParse(raw);
  if (!file.success) {
    return invalid(
      Array.isArray((raw as { nodes?: unknown } | null)?.nodes)
        ? "no links or edges array"
        : "no nodes array",
    );
  }
  const rawEdges = file.data.links ?? file.data.edges;
  if (rawEdges === undefined) return invalid("no links or edges array");

  const nodes = new Map<string, GraphNode>();
  let ignoredNodes = 0;
  for (const value of file.data.nodes) {
    const node = nodeSchema.safeParse(value);
    if (!node.success) {
      ignoredNodes += 1;
      continue;
    }
    nodes.set(node.data.id, {
      id: node.data.id,
      label: node.data.label ?? node.data.id,
      path: normalizeSourcePath(node.data.source_file, repoDir),
      line: parseLine(node.data.source_location),
      fileType: node.data.file_type ?? null,
    });
  }

  const edges: GraphEdge[] = [];
  const unknownConfidences = new Set<string>();
  let ignoredEdges = 0;
  for (const value of rawEdges) {
    const edge = edgeSchema.safeParse(value);
    if (!edge.success) {
      ignoredEdges += 1;
      const confidence = (value as { confidence?: unknown } | null)?.confidence;
      if (
        typeof confidence === "string" &&
        !Object.hasOwn(tierScores, confidence) &&
        unknownConfidences.size < 3
      ) {
        unknownConfidences.add(confidence);
      }
      continue;
    }
    const { _src, _tgt } = edge.data;
    const [source, target] =
      _src !== undefined && _tgt !== undefined
        ? [_src, _tgt]
        : [edge.data.source, edge.data.target];
    if (!nodes.has(source) || !nodes.has(target)) {
      ignoredEdges += 1;
      continue;
    }
    const score = edge.data.confidence_score;
    edges.push({
      source,
      target,
      relation: edge.data.relation,
      provenance: edge.data.confidence,
      score:
        score !== undefined && score >= 0 && score <= 1
          ? score
          : tierScores[edge.data.confidence],
      path: normalizeSourcePath(edge.data.source_file, repoDir),
      line: parseLine(edge.data.source_location),
    });
  }

  const sample =
    unknownConfidences.size === 0
      ? ""
      : ` (for example confidence ${[...unknownConfidences].map((value) => `"${value}"`).join(", ")})`;
  return {
    graph: {
      displayPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      builtAtCommit: file.data.built_at_commit ?? null,
      nodes,
      edges,
      ignoredNodes,
      ignoredEdges,
    },
    issues:
      ignoredNodes + ignoredEdges === 0
        ? []
        : [
            {
              code: "code_graph_schema_drift",
              message: `Ignored ${ignoredEdges} edges and ${ignoredNodes} nodes in ${displayPath} whose shape this rightmodeler does not read${sample}. The rest of the graph is used. Rebuilding with a current Graphify (tested with 0.9.65) usually clears this.`,
            },
          ],
  };
}

function normalizeSourcePath(
  value: string | null | undefined,
  repoDir: string,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  const slashed = value.replaceAll("\\", "/");
  const path = isAbsolute(slashed)
    ? relative(repoDir, slashed).split(sep).join("/")
    : slashed;
  return path.startsWith("./") ? path.slice(2) : path;
}

function parseLine(value: string | number | null | undefined): number | null {
  const match = /^L?([1-9]\d*)$/.exec(String(value));
  return match === null ? null : Number(match[1]);
}

function errorCode(error: unknown): string {
  const { code, message } = error as NodeJS.ErrnoException;
  return code ?? message;
}
