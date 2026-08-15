import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCloudExecutor,
  detectCloudAvailability,
} from "./cloud-sandbox.js";

const availability = await detectCloudAvailability();
const liveReason = availability.available
  ? "available"
  : `${availability.reason}: ${availability.message}`;
if (!availability.available) {
  console.warn(`[cloud sandbox live] SKIPPED — ${liveReason}`);
}

const temporaryDirectories: string[] = [];

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(!availability.available)(
  `cloud sandbox live (${liveReason})`,
  () => {
    it("launches cold, reports status, collects one namespace, and destroys", async () => {
      const root = await mkdtemp(join(tmpdir(), "rightmodeler-cloud-test-"));
      temporaryDirectories.push(root);
      const scratch = join(root, "scratch");
      await mkdir(scratch);
      const executor = createCloudExecutor({ maxBytesPerNamespace: 1024 });
      const handle = await executor.launch({
        image: "vercel/sandbox/universal:latest",
        command: [
          "bash",
          "-lc",
          "mkdir -p /rightmodeler/scratch/facts && printf live >/rightmodeler/scratch/facts/result.txt",
        ],
        env: {},
        mounts: [],
        scratchHostPath: scratch,
        timeoutMs: 30_000,
        labels: { test: "cloud-executor" },
      });

      try {
        for (;;) {
          const status = await executor.status(handle);
          if (status.state === "exited") {
            expect(status.exitCode).toBe(0);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const result = await executor.collect(handle, {
          namespaces: ["facts"],
          scratchHostPath: scratch,
        });
        expect(
          result.files.map((file) => [
            file.path,
            Buffer.from(file.contents).toString("utf8"),
          ]),
        ).toEqual([["result.txt", "live"]]);
      } finally {
        await executor.destroy(handle);
      }
    }, 120_000);
  },
);
