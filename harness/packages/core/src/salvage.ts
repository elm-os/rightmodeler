import { factSchema, type Fact } from "./facts.js";

export type FactRows = string | readonly unknown[];

export interface ParsedFacts {
  facts: Fact[];
  droppedRows: number;
}

type ParsedFactRow =
  { success: true; fact: Fact } | { success: false; message: string };

function rowsFrom(input: FactRows): readonly unknown[] {
  if (typeof input !== "string") {
    return input;
  }
  if (input.length === 0) return [];

  const rows = input.split(/\r?\n/);
  if (rows.length > 1 && rows.at(-1) === "") {
    rows.pop();
  }
  return rows;
}

function firstIssueMessage(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}) {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "Invalid fact";
  }

  const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${location}: ${issue.message}`;
}

function parseFactRow(row: unknown): ParsedFactRow {
  let candidate = row;
  if (typeof row === "string") {
    try {
      candidate = JSON.parse(row);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const parsed = factSchema.safeParse(candidate);
  if (!parsed.success) {
    return { success: false, message: firstIssueMessage(parsed.error) };
  }
  return { success: true, fact: parsed.data };
}

export function parseFacts(input: FactRows): ParsedFacts {
  const facts: Fact[] = [];
  let droppedRows = 0;

  for (const row of rowsFrom(input)) {
    const parsed = parseFactRow(row);
    if (parsed.success) {
      facts.push(parsed.fact);
    } else {
      droppedRows += 1;
    }
  }

  return { facts, droppedRows };
}

export function parseFactsStrict(input: FactRows): Fact[] {
  const facts: Fact[] = [];

  for (const [index, row] of rowsFrom(input).entries()) {
    const parsed = parseFactRow(row);
    if (!parsed.success) {
      throw new Error(`Invalid fact at row ${index + 1}: ${parsed.message}`);
    }
    facts.push(parsed.fact);
  }

  return facts;
}
