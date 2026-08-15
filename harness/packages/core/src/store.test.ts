import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import fc from "fast-check";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { FsStore } from "./store.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function makeStore(): Promise<FsStore> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-core-store-"));
  temporaryDirectories.push(directory);
  return new FsStore(directory);
}

async function makeRuntimeModule(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-core-runtime-"));
  temporaryDirectories.push(directory);
  const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const file = join(directory, "store.mjs");
  await writeFile(file, output);
  return pathToFileURL(file).href;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FsStore", () => {
  it("treats an identical immutable write as idempotent and rejects different bytes", async () => {
    const store = await makeStore();
    const key = "project/facts/fact-1.json";
    const original = Buffer.from("original");

    await store.putImmutable(key, original);
    await expect(
      store.putImmutable(key, Buffer.from("original")),
    ).resolves.toBeUndefined();
    await expect(
      store.putImmutable(key, Buffer.from("different")),
    ).rejects.toThrow(/different bytes/);

    expect(Buffer.from((await store.get(key))!.body)).toEqual(original);
  });

  it("allows one winner among concurrent compare-and-swap attempts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 16 }),
        async (attemptCount) => {
          const store = await makeStore();
          const key = "project/steps/step.json";
          await store.putImmutable(key, Buffer.from("initial"));
          const initial = await store.get(key);
          expect(initial).not.toBeNull();

          const results = await Promise.all(
            Array.from({ length: attemptCount }, (_, index) =>
              new FsStore(store.root).compareAndSwap(
                key,
                initial!.version,
                Buffer.from(`candidate-${index}`),
                initial!.fenceToken,
              ),
            ),
          );

          expect(results.filter(Boolean)).toHaveLength(1);
          const winner = results.indexOf(true);
          const stored = await store.get(key);
          expect(Buffer.from(stored!.body).toString("utf8")).toBe(
            `candidate-${winner}`,
          );
          expect(stored!.version).toBe(initial!.version + 1);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("creates an absent key at version zero and persists versions across instances", async () => {
    const store = await makeStore();
    const key = "project/steps/new.json";

    await expect(
      store.compareAndSwap(key, 0, Buffer.from("created"), 4),
    ).resolves.toBe(true);
    const created = (await new FsStore(store.root).get(key))!;
    expect(Buffer.from(created.body).toString("utf8")).toBe("created");
    expect(created).toMatchObject({ version: 1, fenceToken: 4 });

    await expect(
      store.compareAndSwap(key, 0, Buffer.from("stale-version"), 4),
    ).resolves.toBe(false);
    await expect(
      store.compareAndSwap(key, created.version, Buffer.from("created"), 5),
    ).resolves.toBe(true);
    await expect(new FsStore(store.root).get(key)).resolves.toMatchObject({
      version: 2,
      fenceToken: 5,
    });
  });

  it("rejects a stale fence even when the version matches", async () => {
    const store = await makeStore();
    const key = "project/steps/step.json";
    await store.putImmutable(key, Buffer.from("initial"));
    const initial = (await store.get(key))!;

    expect(
      await store.compareAndSwap(
        key,
        initial.version,
        Buffer.from("claimed"),
        1,
      ),
    ).toBe(true);
    const reclaimed = (await store.get(key))!;
    expect(
      await store.compareAndSwap(
        key,
        reclaimed.version,
        Buffer.from("stale"),
        0,
      ),
    ).toBe(false);
    expect(Buffer.from((await store.get(key))!.body).toString("utf8")).toBe(
      "claimed",
    );
  });

  it("keeps only the latest two envelopes after compare-and-swap", async () => {
    const store = await makeStore();
    const key = "project/steps/versioned.json";
    await store.putImmutable(key, Buffer.from("initial"));
    for (let version = 1; version < 4; version += 1) {
      await expect(
        store.compareAndSwap(
          key,
          version,
          Buffer.from(`version-${version + 1}`),
          version,
        ),
      ).resolves.toBe(true);
    }

    const envelopeDirectory = join(
      store.root,
      ".rightmodeler-store",
      "entries",
      ...key.split("/"),
    );
    expect((await readdir(envelopeDirectory)).sort()).toEqual([
      "v3.json",
      "v4.json",
    ]);
    await expect(store.get(key)).resolves.toMatchObject({
      version: 4,
      fenceToken: 3,
    });
  });

  it("allows one winner across separate processes", async () => {
    const store = await makeStore();
    const key = "project/steps/cross-process.json";
    await store.putImmutable(key, Buffer.from("initial"));
    const initial = (await store.get(key))!;
    const worker = `
      const [moduleUrl, root, key, version, body, fence] = process.argv.slice(1);
      const { FsStore } = await import(moduleUrl);
      const won = await new FsStore(root).compareAndSwap(
        key,
        Number(version),
        Buffer.from(body),
        Number(fence),
      );
      process.stdout.write(String(won));
    `;
    const moduleUrl = await makeRuntimeModule();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        execFileAsync(process.execPath, [
          "--input-type=module",
          "-e",
          worker,
          moduleUrl,
          store.root,
          key,
          String(initial.version),
          `process-${index}`,
          String(initial.fenceToken),
        ]),
      ),
    );

    expect(results.filter(({ stdout }) => stdout === "true")).toHaveLength(1);
  });

  it("supports a transactions key without creating journal or reclaim directories", async () => {
    const store = await makeStore();
    const key = "transactions/fact.json";

    await store.putImmutable(key, Buffer.from("ok"));

    expect(Buffer.from((await store.get(key))!.body).toString("utf8")).toBe(
      "ok",
    );
    await expect(store.list("transactions/")).resolves.toEqual([key]);
    await expect(
      access(join(store.root, ".rightmodeler-store", "transactions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(store.root, ".rightmodeler-store.lock", "reclaim")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists only stored keys under the requested prefix", async () => {
    const store = await makeStore();
    await store.putImmutable("project/facts/b.json", Buffer.from("b"));
    await store.putImmutable("project/facts/a.json", Buffer.from("a"));
    await store.putImmutable("project/steps/a.json", Buffer.from("step"));
    await store.putImmutable(
      "project/reports/.visible.tmp",
      Buffer.from("report"),
    );

    await expect(store.list("project/facts/")).resolves.toEqual([
      "project/facts/a.json",
      "project/facts/b.json",
    ]);
    await expect(store.list("project/reports/")).resolves.toEqual([
      "project/reports/.visible.tmp",
    ]);
  });

  it.each([".rightmodeler-store/key", ".rightmodeler-store.lock/key"])(
    "rejects the reserved internal key %s",
    async (key) => {
      const store = await makeStore();
      await expect(
        store.putImmutable(key, Buffer.from("body")),
      ).rejects.toThrow(/reserved/);
    },
  );
});
