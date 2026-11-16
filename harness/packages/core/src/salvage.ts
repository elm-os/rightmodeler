import { factSchema, type Fact } from "./facts.js";

export type FactRows = string | readonly unknown[];

export interface ParsedFacts {
  facts: Fact[];
  droppedRows: number;
}

type ParsedFactRow = { success: true; fact: Fact } | { success: false };

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

function parseFactRow(row: unknown): ParsedFactRow {
  let candidate = row;
  if (typeof row === "string") {
    try {
      candidate = JSON.parse(row);
    } catch {
      return { success: false };
    }
  }

  const parsed = factSchema.safeParse(candidate);
  if (!parsed.success) {
    return { success: false };
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
