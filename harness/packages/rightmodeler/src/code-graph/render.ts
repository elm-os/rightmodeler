import { escapeCell } from "../report/format.js";
import type { CodeContext, CodeFinding } from "./context.js";
import type { GraphProvenance } from "./graph.js";

function provenanceText(provenance: GraphProvenance, score: number): string {
  switch (provenance) {
    case "EXTRACTED":
      return `EXTRACTED ${score.toFixed(2)}`;
    case "INFERRED":
      return `INFERRED ${score.toFixed(2)}, verify`;
    case "AMBIGUOUS":
      return `AMBIGUOUS ${score.toFixed(2)}, verify`;
    default:
      return provenance satisfies never;
  }
}

function location(path: string, line: number | null): string {
  return `\`${path}${line === null ? "" : `:${line}`}\``;
}

function findingCell(finding: CodeFinding): string {
  if (finding.kind === "owner") return "owner, listed only";
  return finding.hops > 1
    ? `${finding.kind} (${finding.hops} hops)`
    : finding.kind;
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

export function renderCodeContext(context: CodeContext): string[] {
  const lines = [
    "## Code context (Graphify)",
    "",
    "Static code context from a Graphify graph. Graph edges are not replay trials, runtime proof, or quality evidence. They never change a verdict, a gate, confirmation, the proposed swap, or who is asked to review.",
    "",
  ];
  if (context.status === "unavailable") {
    lines.push(`Not shown: ${context.reason}`);
    return lines;
  }
  const ignored =
    context.ignoredEdges + context.ignoredNodes > 0
      ? `, ${context.ignoredEdges} edges and ${context.ignoredNodes} nodes ignored`
      : "";
  const built =
    context.builtAtCommit === null
      ? "an unrecorded commit"
      : `\`${context.builtAtCommit.slice(0, 12)}\``;
  const freshness = context.stale
    ? `Stale: built at ${built}, but the scan is at \`${context.revision.slice(0, 12)}\`. Line-level resolution is off, so enclosing symbols and callers are not shown. Rebuild with \`graphify update .\` at the scanned commit.`
    : `Built at ${built}, the scanned revision.`;
  lines.push(
    `Graph \`${context.graphPath}\`, sha256 \`${context.sha256.slice(0, 12)}\`, ${context.nodes} nodes, ${context.edges} edges${ignored}. ${freshness}`,
    "",
    "| Call site | Family | Finding | Item | Where | Provenance |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const callSite of context.callSites) {
    const site = `${location(callSite.path, callSite.line)}${callSite.enclosingSymbol === null ? "" : ` in \`${callSite.enclosingSymbol}\``}`;
    if (callSite.findings.length === 0) {
      lines.push(
        row([
          site,
          callSite.family,
          callSite.inGraph ? "none found" : "not in graph",
          "",
          "",
          "",
        ]),
      );
      continue;
    }
    for (const finding of callSite.findings) {
      lines.push(
        row([
          site,
          callSite.family,
          findingCell(finding),
          `\`${finding.label}\``,
          location(finding.path, finding.line),
          provenanceText(finding.provenance, finding.score),
        ]),
      );
    }
  }
  if (context.unconfirmedImports.length > 0) {
    lines.push(
      "",
      "Unconfirmed SDK imports: the scanner found no model call site in these files, so they are not call sites and nothing in them was evaluated.",
      "",
      ...context.unconfirmedImports.map(
        (entry) =>
          `- ${location(entry.path, entry.line)} imports \`${entry.module}\` (${provenanceText(entry.provenance, entry.score)}). If it calls a model you want evaluated, add a --matchers rule and rerun.`,
      ),
    );
  }
  lines.push(
    "",
    "EXTRACTED: explicit in source. INFERRED: resolved by inference, verify before relying on it. AMBIGUOUS: uncertain, verify. A multi-hop finding carries its weakest hop. An enclosing symbol is the nearest definition at or above the call line.",
  );
  return lines;
}
