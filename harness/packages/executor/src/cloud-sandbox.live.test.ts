import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCloudExecutor,
  detectCloudAvailability,
  type CloudExecutor,
} from "./cloud-sandbox.js";
import type { DockerHandle, DockerStatus } from "./index.js";

const liveRequested = process.env.RIGHTMODELER_LIVE_CLOUD === "1";
const availability = liveRequested
  ? await detectCloudAvailability()
  : ({
      available: false,
      reason: "not-requested",
      message: "set RIGHTMODELER_LIVE_CLOUD=1 to run live cloud tests",
    } as const);
const liveReason = availability.available
  ? "available"
  : `${availability.reason}: ${availability.message}`;
if (!availability.available) {
  console.warn(`[cloud sandbox live] SKIPPED: ${liveReason}`);
}

const image = "vercel/sandbox/node:24";
const temporaryDirectories: string[] = [];

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The Mode B driver's labels: dotted keys, a 64-character case id. */
function driverLabels(): Record<string, string> {
  return {
    "com.rightmodeler.run": randomUUID(),
    "com.rightmodeler.case": "a".repeat(64),
    "com.rightmodeler.execution": randomUUID(),
  };
}

async function scratchDirectory(): Promise<{ root: string; scratch: string }> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-cloud-test-"));
  temporaryDirectories.push(root);
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  return { root, scratch };
}

async function waitForExit(
  executor: CloudExecutor,
  handle: DockerHandle,
): Promise<DockerStatus> {
  for (;;) {
    const status = await executor.status(handle);
    if (status.state === "exited") return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!availability.available)(
  `cloud sandbox live (${liveReason})`,
  () => {
    it("launches cold, reports status, collects one namespace, and destroys", async () => {
      const { root, scratch } = await scratchDirectory();
      const app = join(root, "app");
      await mkdir(app);
      await writeFile(join(app, "hello.txt"), "mounted");
      const executor = createCloudExecutor({ maxBytesPerNamespace: 1024 });
      const handle = await executor.launch({
        image,
        command: [
          "bash",
          "-lc",
          "mkdir -p /rightmodeler/scratch/facts && cp /rightmodeler/app/hello.txt /rightmodeler/scratch/facts/result.txt",
        ],
        env: {},
        mounts: [
          {
            hostPath: app,
            containerPath: "/rightmodeler/app",
            readOnly: true,
          },
        ],
        scratchHostPath: scratch,
        timeoutMs: 30_000,
        labels: driverLabels(),
      });

      try {
        expect(await waitForExit(executor, handle)).toMatchObject({
          exitCode: 0,
        });
        const result = await executor.collect(handle, {
          namespaces: ["facts"],
          scratchHostPath: scratch,
        });
        expect(
          result.files.map((file) => [
            file.path,
            Buffer.from(file.contents).toString("utf8"),
          ]),
        ).toEqual([["result.txt", "mounted"]]);
      } finally {
        await executor.destroy(handle);
      }
    }, 120_000);

    it("kills a command at its deadline", async () => {
      const { scratch } = await scratchDirectory();
      const executor = createCloudExecutor({ maxBytesPerNamespace: 1024 });
      const handle = await executor.launch({
        image,
        command: ["sleep", "60"],
        env: {},
        mounts: [],
        scratchHostPath: scratch,
        timeoutMs: 3_000,
        labels: driverLabels(),
      });

      try {
        expect(await waitForExit(executor, handle)).toMatchObject({
          exitCode: 137,
          timedOut: true,
        });
      } finally {
        await executor.destroy(handle);
      }
    }, 120_000);

    it.skipIf(!process.env.AI_GATEWAY_API_KEY)(
      "reaches an HTTPS provider through credential brokering",
      async () => {
        const { scratch } = await scratchDirectory();
        const executor = createCloudExecutor({
          maxBytesPerNamespace: 1024,
          modelCredential: {
            host: "ai-gateway.vercel.sh",
            headerName: "authorization",
            value: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
          },
        });
        // The request carries no credential; only the firewall's injected header can turn the
        // gateway's 401 into a 200.
        const handle = await executor.launch({
          image,
          command: [
            "node",
            "-e",
            "fetch('https://ai-gateway.vercel.sh/v1/credits').then(r=>process.exit(r.status===200?0:2),e=>{console.error(e.cause?.code??e.message);process.exit(3)})",
          ],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 30_000,
          labels: driverLabels(),
        });

        try {
          expect(await waitForExit(executor, handle)).toMatchObject({
            exitCode: 0,
          });
        } finally {
          await executor.destroy(handle);
        }
      },
      120_000,
    );
  },
);
