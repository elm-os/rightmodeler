import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { traceAdapters } from "./adapters.js";
import { detectFormat, isRecord, type TraceFormat } from "./adapters/shared.js";

const MAX_FILES = 50;
const MAX_READ_BYTES = 64 * 1024;
const MAX_SAMPLE_RECORDS = 20;
const SOURCE_BUDGETS = { local: 20, claude: 15, codex: 15 } as const;

export interface DiscoveredTrace {
  readonly path: string;
  readonly format: TraceFormat;
  readonly approximateRecords: number;
  readonly modifiedAt: Date;
}

export interface DiscoverTraceOptions {
  readonly repo: string;
  readonly homeDir?: string;
}

interface CandidateFile {
  readonly path: string;
  readonly source: "local" | "claude" | "codex";
  readonly sourceOrder: number;
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface DetectionHead {
  readonly text: string;
  readonly approximateRecords: number;
}

export async function discoverTraces(
  options: DiscoverTraceOptions,
): Promise<DiscoveredTrace[]> {
  const repo = resolve(options.repo);
  const homeDir = resolve(options.homeDir ?? homedir());
  const candidates = await candidateFiles(repo, homeDir);
  const discovered: Array<DiscoveredTrace & { sourceOrder: number }> = [];

  for (const candidate of candidates.slice(0, MAX_FILES)) {
    try {
      const head = await detectionHead(candidate.path, candidate.size);
      if (candidate.source === "codex" && codexSessionCwd(head.text) !== repo) {
        continue;
      }
      const adapter = detectFormat(head.text, traceAdapters);
      discovered.push({
        path: candidate.path,
        format: adapter.name,
        approximateRecords: head.approximateRecords,
        modifiedAt: new Date(candidate.modifiedAtMs),
        sourceOrder: candidate.sourceOrder,
      });
    } catch {}
  }

  return discovered
    .sort(
      (left, right) =>
        right.modifiedAt.getTime() - left.modifiedAt.getTime() ||
        left.sourceOrder - right.sourceOrder ||
        compareText(left.path, right.path),
    )
    .map(({ sourceOrder: _sourceOrder, ...candidate }) => candidate);
}

export function sanitizeClaudeProjectPath(repo: string): string {
  const absolute = resolve(repo);
  const sanitized = absolute.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let index = 0; index < absolute.length; index += 1) {
    hash = (hash * 31 + absolute.charCodeAt(index)) | 0;
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function candidateFiles(
  repo: string,
  homeDir: string,
): Promise<CandidateFile[]> {
  const localPaths = await localCandidatePaths(repo);
  const claudePaths = (
    await jsonFiles(
      join(homeDir, ".claude", "projects", sanitizeClaudeProjectPath(repo)),
      false,
    )
  ).sort(compareText);
  const codexPaths = (
    await jsonFiles(join(homeDir, ".codex", "sessions"), true)
  )
    .filter((path) => path.endsWith(".jsonl"))
    .sort((left, right) => compareText(right, left));
  const sources = [
    {
      source: "local" as const,
      files: await statCandidates(localPaths, "local", false),
    },
    {
      source: "claude" as const,
      files: await statCandidates(claudePaths, "claude", true),
    },
    {
      source: "codex" as const,
      files: await statCandidates(codexPaths, "codex", false),
    },
  ];
  const selected: CandidateFile[] = [];
  const offsets = new Map<CandidateFile["source"], number>();
  for (const source of sources) {
    const count = Math.min(SOURCE_BUDGETS[source.source], source.files.length);
    selected.push(...source.files.slice(0, count));
    offsets.set(source.source, count);
  }
  for (const source of sources) {
    const remaining = MAX_FILES - selected.length;
    if (remaining === 0) break;
    const offset = offsets.get(source.source) ?? 0;
    const extra = source.files.slice(offset, offset + remaining);
    selected.push(...extra);
    offsets.set(source.source, offset + extra.length);
  }
  return selected.map((file, sourceOrder) => ({ ...file, sourceOrder }));
}

async function statCandidates(
  paths: readonly string[],
  source: CandidateFile["source"],
  sortNewest: boolean,
): Promise<CandidateFile[]> {
  const selectedPaths = sortNewest ? paths : paths.slice(0, MAX_FILES);
  const files = (
    await Promise.all(
      selectedPaths.map(async (path): Promise<CandidateFile | undefined> => {
        try {
          const metadata = await stat(path);
          return {
            path,
            source,
            sourceOrder: 0,
            size: metadata.size,
            modifiedAtMs: metadata.mtimeMs,
          };
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((file): file is CandidateFile => file !== undefined);
  if (sortNewest) {
    files.sort(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs ||
        compareText(left.path, right.path),
    );
  }
  return files.slice(0, MAX_FILES);
}

async function localCandidatePaths(repo: string): Promise<string[]> {
  const tracesDirectory = join(repo, "traces");
  const [realRepo, realTracesDirectory] = await Promise.all([
    realpath(repo).catch(() => undefined),
    realpath(tracesDirectory).catch(() => undefined),
  ]);
  const nested =
    realRepo !== undefined &&
    realTracesDirectory !== undefined &&
    isWithin(realRepo, realTracesDirectory)
      ? (await jsonFiles(tracesDirectory, false)).sort(compareText)
      : [];
  const topLevel = (await jsonFiles(repo, false)).sort((left, right) => {
    const leftJsonl = left.endsWith(".jsonl");
    const rightJsonl = right.endsWith(".jsonl");
    return leftJsonl === rightJsonl
      ? compareText(left, right)
      : leftJsonl
        ? -1
        : 1;
  });
  const topLevelSet = new Set(topLevel);
  return unique([
    ...[join(repo, "traces.json"), join(repo, "traces.jsonl")].filter((path) =>
      topLevelSet.has(path),
    ),
    ...nested,
    ...topLevel,
  ]);
}

async function jsonFiles(root: string, recursive: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

async function detectionHead(
  path: string,
  fileSize: number,
): Promise<DetectionHead> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, fileSize));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.toString("utf8", 0, bytesRead);
    const complete = bytesRead === fileSize;
    const parsed = complete ? parseWholeJson(raw) : undefined;
    if (parsed !== undefined) {
      const records = Array.isArray(parsed) ? parsed : [parsed];
      return {
        text: JSON.stringify(records.slice(0, MAX_SAMPLE_RECORDS)),
        approximateRecords: Math.max(1, records.length),
      };
    }

    const trimmed = raw.trimStart();
    if (trimmed.startsWith("[")) {
      const records = leadingArrayRecords(trimmed, MAX_SAMPLE_RECORDS);
      return {
        text: JSON.stringify(records),
        approximateRecords: approximateRecordCount(
          records.length,
          bytesRead,
          fileSize,
        ),
      };
    }

    const completeText = complete
      ? raw
      : raw.slice(0, Math.max(0, raw.lastIndexOf("\n") + 1));
    const lines = completeText
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    return {
      text: lines.slice(0, MAX_SAMPLE_RECORDS).join("\n"),
      approximateRecords: approximateRecordCount(
        lines.length,
        bytesRead,
        fileSize,
      ),
    };
  } finally {
    await handle.close();
  }
}

function leadingArrayRecords(text: string, limit: number): unknown[] {
  const records: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let index = 1;
    index < text.length && records.length < limit;
    index += 1
  ) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      if (start === -1) start = index;
      continue;
    }
    if (start === -1) {
      if (/\s|,/u.test(character)) continue;
      if (character === "]") break;
      start = index;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (depth === 0 && (character === "}" || character === "]")) {
      const parsed = parseWholeJson(text.slice(start, index + 1));
      if (parsed !== undefined) records.push(parsed);
      start = -1;
    }
  }
  return records;
}

function codexSessionCwd(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const record = parseWholeJson(line);
    if (
      isRecord(record) &&
      record.type === "session_meta" &&
      isRecord(record.payload) &&
      typeof record.payload.cwd === "string"
    ) {
      return resolve(record.payload.cwd);
    }
  }
  return undefined;
}

function parseWholeJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function approximateRecordCount(
  observed: number,
  bytesRead: number,
  fileSize: number,
): number {
  if (observed === 0) return 0;
  if (bytesRead === 0 || bytesRead === fileSize) return observed;
  return Math.max(observed, Math.round((observed * fileSize) / bytesRead));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
