import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative, sep, win32 } from "node:path";

export type Bytes = Uint8Array;
export type Version = number;
export type FenceToken = number;

export interface StoreEntry {
  body: Bytes;
  version: Version;
  fenceToken: FenceToken;
}

export interface Store {
  get(key: string): Promise<StoreEntry | null>;
  list(prefix: string): Promise<string[]>;
  putImmutable(key: string, body: Bytes): Promise<void>;
  compareAndSwap(
    key: string,
    expectedVersion: Version,
    body: Bytes,
    fenceToken: FenceToken,
  ): Promise<boolean>;
}

interface Envelope {
  version: Version;
  fenceToken: FenceToken;
  bodyBase64: string;
}

const metadataDirectory = ".rightmodeler-store";
const entriesDirectory = "entries";
const temporaryDirectory = "temporary";
const lockDirectory = ".rightmodeler-store.lock";
const reservedStoreSegments = new Set([metadataDirectory, lockDirectory]);
const versionFilePattern = /^v([1-9]\d*)\.json$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function assertStoreKey(key: string, allowEmpty: boolean): void {
  if (typeof key !== "string" || (!allowEmpty && key.length === 0)) {
    throw new Error("Store key must be a non-empty string");
  }
  if (key.includes("\0")) {
    throw new Error("Store key must not contain a NUL byte");
  }
  if (key.includes("\\") || posix.isAbsolute(key) || win32.isAbsolute(key)) {
    throw new Error("Store key must be relative and use forward slashes");
  }

  const trimmed = allowEmpty && key.endsWith("/") ? key.slice(0, -1) : key;
  if (trimmed.length === 0 && allowEmpty) return;
  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Store key contains an unsafe path segment");
  }
  if (reservedStoreSegments.has(segments[0]!)) {
    throw new Error("Store key uses a reserved first segment");
  }
}

function parseEnvelope(raw: string, source: string): Envelope {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid store envelope at ${source}`);
  }
  const envelope = value as Record<string, unknown>;
  const version = envelope.version;
  const fenceToken = envelope.fenceToken;
  const bodyBase64 = envelope.bodyBase64;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof fenceToken !== "number" ||
    !Number.isSafeInteger(fenceToken) ||
    fenceToken < 0 ||
    typeof bodyBase64 !== "string"
  ) {
    throw new Error(`Invalid store envelope at ${source}`);
  }
  return { version, fenceToken, bodyBase64 };
}

function encodeEnvelope(envelope: Envelope): Buffer {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

export class FsStore implements Store {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async get(key: string): Promise<StoreEntry | null> {
    assertStoreKey(key, false);
    const current = await this.readCurrent(key);
    if (current === null) return null;
    return {
      body: Buffer.from(current.bodyBase64, "base64"),
      version: current.version,
      fenceToken: current.fenceToken,
    };
  }

  async list(prefix: string): Promise<string[]> {
    assertStoreKey(prefix, true);
    const keys: string[] = [];
    await this.walkEntries(this.entriesRoot(), keys);
    return keys.filter((key) => key.startsWith(prefix)).sort();
  }

  async putImmutable(key: string, body: Bytes): Promise<void> {
    assertStoreKey(key, false);
    const envelope: Envelope = {
      version: 1,
      fenceToken: 0,
      bodyBase64: Buffer.from(body).toString("base64"),
    };
    if (
      await this.writeAtomic(this.versionPath(key, 1), encodeEnvelope(envelope))
    ) {
      return;
    }

    const existing = await this.get(key);
    if (
      existing !== null &&
      Buffer.from(existing.body).equals(Buffer.from(body))
    ) {
      return;
    }
    throw new Error(
      `Immutable key already exists with different bytes: ${key}`,
    );
  }

  async compareAndSwap(
    key: string,
    expectedVersion: Version,
    body: Bytes,
    fenceToken: FenceToken,
  ): Promise<boolean> {
    assertStoreKey(key, false);
    const current = await this.readCurrent(key);
    const currentVersion = current?.version ?? 0;
    const currentFenceToken = current?.fenceToken ?? 0;
    if (currentVersion !== expectedVersion || fenceToken < currentFenceToken) {
      return false;
    }

    const nextVersion = currentVersion + 1;
    const envelope: Envelope = {
      version: nextVersion,
      fenceToken,
      bodyBase64: Buffer.from(body).toString("base64"),
    };
    const committed = await this.writeAtomic(
      this.versionPath(key, nextVersion),
      encodeEnvelope(envelope),
    );
    if (!committed) return false;
    await this.pruneOldVersions(key, nextVersion);
    return true;
  }

  private entriesRoot(): string {
    return join(this.root, metadataDirectory, entriesDirectory);
  }

  private entryDirectory(key: string): string {
    return join(this.entriesRoot(), ...key.split("/"));
  }

  private versionPath(key: string, version: Version): string {
    return join(this.entryDirectory(key), `v${version}.json`);
  }

  private async readCurrent(key: string): Promise<Envelope | null> {
    const directory = this.entryDirectory(key);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return null;
      // Nested-key collisions surface as ENOTDIR in this fs implementation; other stores may differ.
      throw error;
    }

    let highestVersion = 0;
    let highestFile: string | null = null;
    for (const name of names) {
      const match = versionFilePattern.exec(name);
      if (match === null) continue;
      const version = Number(match[1]);
      if (version > highestVersion) {
        highestVersion = version;
        highestFile = join(directory, name);
      }
    }
    if (highestFile === null) return null;

    let raw: string;
    try {
      raw = await readFile(highestFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return this.readCurrent(key);
      throw error;
    }
    const envelope = parseEnvelope(raw, highestFile);
    if (envelope.version !== highestVersion) {
      throw new Error(`Invalid store envelope at ${highestFile}`);
    }
    return envelope;
  }

  private async writeAtomic(file: string, body: Bytes): Promise<boolean> {
    await mkdir(dirname(file), { recursive: true });
    const temporaryRoot = join(
      this.root,
      metadataDirectory,
      temporaryDirectory,
    );
    await mkdir(temporaryRoot, { recursive: true });
    const temporary = join(temporaryRoot, randomUUID());
    try {
      await writeFile(temporary, body, { flag: "wx" });
      try {
        await link(temporary, file);
        return true;
      } catch (error) {
        if (isAlreadyPresent(error)) return false;
        throw error;
      }
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  private async pruneOldVersions(
    key: string,
    latestVersion: Version,
  ): Promise<void> {
    const directory = this.entryDirectory(key);
    try {
      const names = await readdir(directory);
      await Promise.all(
        names.map(async (name) => {
          const match = versionFilePattern.exec(name);
          if (match === null || Number(match[1]) >= latestVersion - 1) return;
          await unlink(join(directory, name)).catch(() => undefined);
        }),
      );
    } catch {
      // Retention is best-effort and never changes whether the commit won.
    }
  }

  private async walkEntries(directory: string, keys: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }

    if (
      entries.some(
        (entry) => entry.isFile() && versionFilePattern.test(entry.name),
      )
    ) {
      const key = relative(this.entriesRoot(), directory).split(sep).join("/");
      await this.readCurrent(key);
      keys.push(key);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.walkEntries(join(directory, entry.name), keys);
      }
    }
  }
}
