import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecutorProvider } from "@rightmodeler/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDockerExecutor,
  ensureImage,
  SCRATCH_CONTAINER_PATH,
  type DockerExecutor,
  type DockerHandle,
  type DockerStatus,
} from "./index.js";

const provider: ExecutorProvider = createDockerExecutor({
  maxBytesPerNamespace: 1,
});
void provider;

const execFileAsync = promisify(execFile);
const testTimeoutMs = 120_000;
const activeContainers: Array<{
  executor: DockerExecutor;
  handle: DockerHandle;
}> = [];
const temporaryDirectories: string[] = [];
const activeServers: Server[] = [];

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function createScratch(): Promise<{
  root: string;
  scratch: string;
}> {
  const root = await mkdtemp(join(import.meta.dirname, ".docker,test-"));
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  temporaryDirectories.push(root);
  return { root, scratch };
}

function track(executor: DockerExecutor, handle: DockerHandle): DockerHandle {
  activeContainers.push({ executor, handle });
  return handle;
}

async function waitForExit(
  executor: DockerExecutor,
  handle: DockerHandle,
  waitMs = 20_000,
): Promise<DockerStatus> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const current = await executor.status(handle);
    if (current.state === "exited") return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Container ${handle} did not exit within ${waitMs}ms`);
}

beforeEach(async () => {
  try {
    await execFileAsync("docker", ["ps"], { encoding: "utf8" });
  } catch {
    throw new Error("Docker is required to run @rightmodeler/executor tests.");
  }
});

afterEach(async () => {
  for (const { executor, handle } of activeContainers.splice(0)) {
    await executor.destroy(handle);
  }
  for (const server of activeServers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("docker executor", () => {
  it(
    "launches with env and collects exactly the requested namespaces",
    async () => {
      const { root, scratch } = await createScratch();
      const input = join(root, "input");
      await mkdir(input);
      await writeFile(join(input, "value.txt"), "mounted-value");
      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const script = `
        const fs = require("node:fs");
        const root = ${JSON.stringify(SCRATCH_CONTAINER_PATH)};
        console.log(process.env.MODE_B_VALUE);
        fs.mkdirSync(root + "/facts", { recursive: true });
        fs.mkdirSync(root + "/metrics/nested", { recursive: true });
        fs.mkdirSync(root + "/private", { recursive: true });
        fs.writeFileSync(root + "/facts/env.txt", process.env.MODE_B_VALUE);
        fs.writeFileSync(root + "/facts/mount.txt", fs.readFileSync("/input/value.txt"));
        let mountIsReadOnly = false;
        try { fs.writeFileSync("/input/new.txt", "write"); } catch { mountIsReadOnly = true; }
        fs.writeFileSync(root + "/facts/mount-read-only.txt", String(mountIsReadOnly));
        fs.writeFileSync(root + "/metrics/nested/count.txt", "2");
        fs.writeFileSync(root + "/private/hidden.txt", "do not collect");
        fs.writeFileSync(root + "/.heartbeat", "alive");
      `;

      const handle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: ["node", "-e", script],
          env: { MODE_B_VALUE: "from-container" },
          mounts: [
            {
              hostPath: input,
              containerPath: "/input",
              readOnly: true,
            },
          ],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          labels: { "com.rightmodeler.test": "collect" },
        }),
      );

      const status = await waitForExit(executor, handle);
      const result = await executor.collect(handle, {
        namespaces: ["facts", "metrics"],
        scratchHostPath: scratch,
      });

      expect(await docker(["logs", handle])).toBe("from-container");
      expect(
        await docker([
          "inspect",
          "--format",
          '{{ index .Config.Labels "com.rightmodeler.test" }}',
          handle,
        ]),
      ).toBe("collect");
      expect(
        await docker([
          "inspect",
          "--format",
          '{{ index .Config.Labels "com.rightmodeler.executor" }}',
          handle,
        ]),
      ).toBe("1");
      expect(
        await docker([
          "inspect",
          "--format",
          '{{ index .Config.Labels "com.rightmodeler.executor.run" }}',
          handle,
        ]),
      ).not.toBe("");
      expect(status).toMatchObject({
        state: "exited",
        exitCode: 0,
        oomKilled: false,
        timedOut: false,
      });
      expect(Date.parse(status.startedAt)).not.toBeNaN();
      expect(Date.parse(status.heartbeatAt ?? "")).not.toBeNaN();
      expect(
        result.files.map((file) => ({
          namespace: file.namespace,
          path: file.path,
          contents: Buffer.from(file.contents).toString("utf8"),
        })),
      ).toEqual([
        {
          namespace: "facts",
          path: "env.txt",
          contents: "from-container",
        },
        {
          namespace: "facts",
          path: "mount-read-only.txt",
          contents: "true",
        },
        {
          namespace: "facts",
          path: "mount.txt",
          contents: "mounted-value",
        },
        {
          namespace: "metrics",
          path: "nested/count.txt",
          contents: "2",
        },
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.files.some((file) => file.namespace === "private")).toBe(
        false,
      );
    },
    testTimeoutMs,
  );

  it(
    "skips an oversized file and continues collecting its namespace",
    async () => {
      const { scratch } = await createScratch();
      const executor = createDockerExecutor({ maxBytesPerNamespace: 10 });
      const script = `
        const fs = require("node:fs");
        const root = ${JSON.stringify(SCRATCH_CONTAINER_PATH)} + "/facts";
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(root + "/a-small.txt", "12345");
        fs.writeFileSync(root + "/b-large.txt", "x".repeat(20));
        fs.writeFileSync(root + "/c-small.txt", "6789");
      `;
      const handle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: ["node", "-e", script],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          labels: {},
        }),
      );
      await waitForExit(executor, handle);

      const result = await executor.collect(handle, {
        namespaces: ["facts"],
        scratchHostPath: scratch,
      });

      expect(
        result.files.map((file) => [
          file.path,
          Buffer.from(file.contents).toString("utf8"),
        ]),
      ).toEqual([
        ["a-small.txt", "12345"],
        ["c-small.txt", "6789"],
      ]);
      expect(result.skipped).toEqual([
        {
          namespace: "facts",
          path: "b-large.txt",
          bytes: 20,
          skipped: true,
        },
      ]);
    },
    testTimeoutMs,
  );

  it(
    "kills a timed-out container and every process inside it",
    async () => {
      const { scratch } = await createScratch();
      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const script = `
import subprocess
import time
subprocess.Popen(["python", "-c", "import time; time.sleep(60)"])
while True:
    time.sleep(1)
      `;
      const handle = track(
        executor,
        await executor.launch({
          image: "python:3.12-alpine",
          command: ["python", "-c", script],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 3_000,
          labels: {},
        }),
      );

      let processTable = "";
      const processDeadline = Date.now() + 2_000;
      while (Date.now() < processDeadline) {
        processTable = await docker(["top", handle]);
        if (processTable.split("\n").length === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processTable.split("\n")).toHaveLength(3);
      const status = await waitForExit(executor, handle);

      expect(status).toMatchObject({
        state: "exited",
        exitCode: 137,
        oomKilled: false,
        timedOut: true,
      });
      expect(
        await docker(["inspect", "--format", "{{.State.Pid}}", handle]),
      ).toBe("0");
    },
    testTimeoutMs,
  );

  it(
    "rejects namespace traversal and skips hostile entries",
    async () => {
      const { root, scratch } = await createScratch();
      await writeFile(join(root, "escape.txt"), "outside scratch");
      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const script = `
        const fs = require("node:fs");
        const root = ${JSON.stringify(SCRATCH_CONTAINER_PATH)} + "/facts";
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(root + "/a-safe.txt", "before");
        fs.writeFileSync(root + "/.rightmodeler-store", "reserved");
        fs.writeFileSync(root + "/z-safe.txt", "after");
        fs.symlinkSync("../../escape.txt", root + "/escape.txt");
      `;
      const handle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: ["node", "-e", script],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          labels: {},
        }),
      );
      await waitForExit(executor, handle);

      await expect(
        executor.collect(handle, {
          namespaces: [".."],
          scratchHostPath: scratch,
        }),
      ).rejects.toThrow(/Invalid namespace/);
      const result = await executor.collect(handle, {
        namespaces: ["facts"],
        scratchHostPath: scratch,
      });

      expect(
        result.files.map((file) => [
          file.path,
          Buffer.from(file.contents).toString("utf8"),
        ]),
      ).toEqual([
        ["a-safe.txt", "before"],
        ["z-safe.txt", "after"],
      ]);
      expect(result.skipped).toEqual([
        {
          namespace: "facts",
          path: ".rightmodeler-store",
          bytes: 8,
          skipped: true,
        },
        {
          namespace: "facts",
          path: "escape.txt",
          bytes: 16,
          skipped: true,
        },
      ]);
    },
    testTimeoutMs,
  );

  it(
    "reaches a host listener through host.docker.internal without publishing a port",
    async () => {
      const { scratch } = await createScratch();
      const server = createServer((_request, response) => {
        response.end("host-response");
      });
      activeServers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "0.0.0.0", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Host test listener did not expose a TCP port");
      }

      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const script = `
        const fs = require("node:fs");
        const root = ${JSON.stringify(SCRATCH_CONTAINER_PATH)} + "/facts";
        fs.mkdirSync(root, { recursive: true });
        fetch("http://host.docker.internal:${address.port}")
          .then((response) => response.text())
          .then((body) => fs.writeFileSync(root + "/response.txt", body));
      `;
      const handle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: ["node", "-e", script],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          hostPorts: [
            {
              containerHost: "host.docker.internal",
              note: `test listener on host port ${address.port}`,
            },
          ],
          labels: {},
        }),
      );
      expect((await waitForExit(executor, handle)).exitCode).toBe(0);

      const result = await executor.collect(handle, {
        namespaces: ["facts"],
        scratchHostPath: scratch,
      });

      expect(result.files).toHaveLength(1);
      expect(Buffer.from(result.files[0].contents).toString("utf8")).toBe(
        "host-response",
      );
      expect(await docker(["port", handle])).toBe("");
      expect(
        await docker([
          "inspect",
          "--format",
          "{{.HostConfig.NetworkMode}}",
          handle,
        ]),
      ).toBe("bridge");
      expect(
        await docker([
          "inspect",
          "--format",
          "{{json .HostConfig.PortBindings}}",
          handle,
        ]),
      ).toBe("{}");
      expect(
        await docker([
          "inspect",
          "--format",
          "{{json .HostConfig.ExtraHosts}}",
          handle,
        ]),
      ).toBe(
        process.platform === "linux"
          ? '["host.docker.internal:host-gateway"]'
          : "null",
      );
    },
    testTimeoutMs,
  );

  it(
    "destroys idempotently and launches a fresh container afterward",
    async () => {
      const { scratch } = await createScratch();
      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const firstHandle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: [
            "node",
            "-e",
            'require("node:fs").writeFileSync("/container-state", "first")',
          ],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          labels: {},
        }),
      );
      await waitForExit(executor, firstHandle);
      await executor.destroy(firstHandle);
      await executor.destroy(firstHandle);
      await expect(docker(["inspect", firstHandle])).rejects.toThrow(
        /No such object|No such container/i,
      );

      const script = `
        const fs = require("node:fs");
        const root = ${JSON.stringify(SCRATCH_CONTAINER_PATH)} + "/facts";
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(root + "/fresh.txt", String(fs.existsSync("/container-state")));
      `;
      const secondHandle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: ["node", "-e", script],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          labels: {},
        }),
      );
      await waitForExit(executor, secondHandle);
      const result = await executor.collect(secondHandle, {
        namespaces: ["facts"],
        scratchHostPath: scratch,
      });

      expect(secondHandle).not.toBe(firstHandle);
      expect(Buffer.from(result.files[0].contents).toString("utf8")).toBe(
        "false",
      );
    },
    testTimeoutMs,
  );

  it(
    "collects from caller-owned scratch after the container is destroyed",
    async () => {
      const { scratch } = await createScratch();
      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const script = `
        const fs = require("node:fs");
        const root = ${JSON.stringify(SCRATCH_CONTAINER_PATH)} + "/facts";
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(root + "/salvaged.txt", "persisted");
      `;
      const handle = track(
        executor,
        await executor.launch({
          image: "node:22-alpine",
          command: ["node", "-e", script],
          env: {},
          mounts: [],
          scratchHostPath: scratch,
          timeoutMs: 10_000,
          labels: {},
        }),
      );
      await waitForExit(executor, handle);
      await executor.destroy(handle);

      const result = await executor.collect(handle, {
        namespaces: ["facts"],
        scratchHostPath: scratch,
      });

      expect(Buffer.from(result.files[0].contents).toString("utf8")).toBe(
        "persisted",
      );
    },
    testTimeoutMs,
  );

  it(
    "reaps old executor containers without touching unlabeled containers",
    async () => {
      const executor = createDockerExecutor({ maxBytesPerNamespace: 1024 });
      const orphan = track(
        executor,
        await docker([
          "run",
          "--detach",
          "--label",
          "com.rightmodeler.executor=1",
          "node:22-alpine",
          "node",
          "-e",
          "setInterval(() => {}, 60_000)",
        ]),
      );
      const unlabeled = track(
        executor,
        await docker([
          "run",
          "--detach",
          "node:22-alpine",
          "node",
          "-e",
          "setInterval(() => {}, 60_000)",
        ]),
      );

      await executor.reapOrphans({ olderThanMs: 60_000 });
      expect(
        await docker(["inspect", "--format", "{{.State.Status}}", orphan]),
      ).toBe("running");
      expect(
        await docker(["inspect", "--format", "{{.State.Status}}", unlabeled]),
      ).toBe("running");

      await executor.reapOrphans({ olderThanMs: 0 });

      await expect(docker(["inspect", orphan])).rejects.toThrow(
        /No such object|No such container/i,
      );
      expect(
        await docker(["inspect", "--format", "{{.State.Status}}", unlabeled]),
      ).toBe("running");
    },
    testTimeoutMs,
  );

  it(
    "names the image when pulling it fails",
    async () => {
      const image = "not a valid image";
      await expect(ensureImage(image)).rejects.toThrow(
        `Failed to pull Docker image "${image}"`,
      );
    },
    testTimeoutMs,
  );
});
