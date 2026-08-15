import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorProvider } from "@rightmodeler/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCloudNetworkPolicy,
  createCloudExecutor,
  detectCloudAvailability,
  parseCloudCollectionManifest,
} from "./cloud-sandbox.js";

const mocks = vi.hoisted(() => {
  const sandboxes = new Map<string, FakeSandbox>();
  const creates: Array<Record<string, unknown>> = [];
  let nextId = 1;
  let createFailure: Error | undefined;

  class FakeCommand {
    readonly cmdId = "cmd-1";
    readonly startedAt = Date.now();
    exitCode: number | null = null;

    async wait(): Promise<FakeCommand> {
      this.exitCode = 0;
      return this;
    }
  }

  class FakeSandbox {
    static async create(
      options: Record<string, unknown>,
    ): Promise<FakeSandbox> {
      if (createFailure !== undefined) throw createFailure;
      creates.push(options);
      const sandbox = new FakeSandbox(`cloud-${nextId++}`);
      sandboxes.set(sandbox.name, sandbox);
      return sandbox;
    }

    static async get(options: { name: string }): Promise<FakeSandbox> {
      const sandbox = sandboxes.get(options.name);
      if (sandbox !== undefined) return sandbox;
      const error = Object.assign(new Error("not found"), {
        response: { status: 404 },
      });
      throw error;
    }

    readonly command = new FakeCommand();
    readonly files = new Map<string, Uint8Array>();
    readonly writes: Array<{
      path: string;
      content: string | Uint8Array;
      mode?: number;
    }> = [];
    readonly commands: Array<{
      cmd: string;
      detached?: boolean;
      timeoutMs?: number;
    }> = [];
    readonly name: string;
    status = "running";
    deleted = false;
    manifest = "";

    readonly fs = {
      exists: async (): Promise<boolean> => false,
      lstat: async (): Promise<{ mtime: Date }> => ({ mtime: new Date(0) }),
    };

    constructor(name: string) {
      this.name = name;
    }

    currentSession(): { getCommand: () => Promise<FakeCommand> } {
      return { getCommand: async () => this.command };
    }

    async runCommand(params: {
      cmd: string;
      detached?: boolean;
      timeoutMs?: number;
    }): Promise<
      | FakeCommand
      | {
          exitCode: number;
          stdout: () => Promise<string>;
          stderr: () => Promise<string>;
        }
    > {
      this.commands.push(params);
      if (params.detached === true) return this.command;
      return {
        exitCode: 0,
        stdout: async () => (params.cmd === "find" ? this.manifest : ""),
        stderr: async () => "",
      };
    }

    async writeFiles(
      files: Array<{
        path: string;
        content: string | Uint8Array;
        mode?: number;
      }>,
    ): Promise<void> {
      this.writes.push(...files);
    }

    async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
      const contents = this.files.get(file.path);
      return contents === undefined ? null : Buffer.from(contents);
    }

    async delete(): Promise<void> {
      this.deleted = true;
      sandboxes.delete(this.name);
    }
  }

  return {
    FakeSandbox,
    creates,
    sandboxes,
    failCreate(error: Error | undefined): void {
      createFailure = error;
    },
    reset(): void {
      creates.length = 0;
      sandboxes.clear();
      nextId = 1;
      createFailure = undefined;
    },
  };
});

vi.mock("@vercel/sandbox", () => ({ Sandbox: mocks.FakeSandbox }));

const provider: ExecutorProvider = createCloudExecutor({
  maxBytesPerNamespace: 1,
});
void provider;

const originalEnv = { ...process.env };
let scratchPath: string;

beforeEach(async () => {
  mocks.reset();
  scratchPath = await mkdtemp(join(tmpdir(), "rightmodeler-cloud-contract-"));
  process.env.VERCEL_OIDC_TOKEN = "test-oidc";
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_PROJECT_ID;
});

afterEach(async () => {
  await rm(scratchPath, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

function launchSpec() {
  return {
    image: "vercel/sandbox/universal:latest",
    command: ["node", "-e", "process.exit(0)"],
    env: { OPENAI_API_KEY: "sandbox-placeholder" },
    mounts: [],
    scratchHostPath: scratchPath,
    timeoutMs: 1_000,
    labels: {},
  } as const;
}

describe("cloud sandbox contract", () => {
  it("reports missing credentials with a named reason", async () => {
    delete process.env.VERCEL_OIDC_TOKEN;

    await expect(detectCloudAvailability()).resolves.toEqual({
      available: false,
      reason: "credentials-unavailable",
      message:
        "Set VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
    });

    process.env.VERCEL_TOKEN = "token";
    process.env.VERCEL_TEAM_ID = "team";
    process.env.VERCEL_PROJECT_ID = "project";
    await expect(detectCloudAvailability()).resolves.toEqual({
      available: true,
    });
  });

  it("validates options and unsupported host networking", async () => {
    expect(() => createCloudExecutor({ maxBytesPerNamespace: 0 })).toThrow(
      /positive safe integer/,
    );
    expect(() =>
      createCloudExecutor({
        maxBytesPerNamespace: 1,
        modelCredential: {
          host: "https://api.openai.com",
          headerName: "authorization",
          value: "secret",
        },
      }),
    ).toThrow(/exact hostname/);

    const executor = createCloudExecutor({ maxBytesPerNamespace: 1 });
    await expect(
      executor.launch({
        ...launchSpec(),
        hostPorts: [
          {
            containerHost: "host.docker.internal",
            note: "local proxy",
          },
        ],
      }),
    ).rejects.toThrow(/public HTTPS egress endpoint/);
  });

  it("creates a cold sandbox per launch and brokers the key only in the firewall", async () => {
    const executor = createCloudExecutor({
      maxBytesPerNamespace: 10,
      modelCredential: {
        host: "api.openai.com",
        headerName: "authorization",
        value: "Bearer host-secret",
      },
    });

    const first = await executor.launch(launchSpec());
    const second = await executor.launch(launchSpec());

    expect(first).not.toBe(second);
    expect(mocks.creates).toHaveLength(2);
    expect(mocks.creates[0]).toMatchObject({
      image: "vercel/sandbox/universal:latest",
      persistent: false,
      env: { OPENAI_API_KEY: "sandbox-placeholder" },
      networkPolicy: {
        allow: {
          "api.openai.com": [
            {
              transform: [
                {
                  headers: {
                    authorization: "Bearer host-secret",
                  },
                },
              ],
            },
          ],
          "*": [],
        },
      },
    });
    expect(JSON.stringify(mocks.creates[0]?.env)).not.toContain("host-secret");
    expect(mocks.creates[0]?.timeout).toBe(61_000);
    const [sandbox] = [...mocks.sandboxes.values()];
    expect(
      sandbox?.commands.find((command) => command.detached === true),
    ).toMatchObject({ timeoutMs: 1_000 });
    await expect(executor.status(first)).resolves.toMatchObject({
      state: "exited",
      exitCode: 0,
      oomKilled: false,
      timedOut: false,
    });
  });

  it("rejects putting the brokered key inside the sandbox", async () => {
    const executor = createCloudExecutor({
      maxBytesPerNamespace: 10,
      modelCredential: {
        host: "api.openai.com",
        headerName: "authorization",
        value: "host-secret",
      },
    });

    await expect(
      executor.launch({
        ...launchSpec(),
        env: { OPENAI_API_KEY: "host-secret" },
      }),
    ).rejects.toThrow(/must not be present/);
    expect(mocks.creates).toHaveLength(0);
  });

  it("maps launch failures and tears down idempotently", async () => {
    const executor = createCloudExecutor({ maxBytesPerNamespace: 10 });
    mocks.failCreate(new Error("provider rejected image"));

    await expect(executor.launch(launchSpec())).rejects.toThrow(
      /Failed to launch cloud sandbox image.*provider rejected image/,
    );

    mocks.failCreate(undefined);
    const handle = await executor.launch(launchSpec());
    const [sandbox] = [...mocks.sandboxes.values()];
    await executor.destroy(handle);
    await executor.destroy(handle);
    expect(sandbox?.deleted).toBe(true);
  });
});

describe("cloud collection parsing", () => {
  it("parses files, sorts them, and skips hostile entries", () => {
    const parsed = parseCloudCollectionManifest(
      "facts",
      "/rightmodeler/scratch/facts",
      [
        "d",
        "0",
        "",
        "f",
        "4",
        "z-safe.txt",
        "f",
        "8",
        ".rightmodeler-store",
        "l",
        "12",
        "escape.txt",
        "f",
        "5",
        "nested/a.txt",
        "",
      ].join("\0"),
    );

    expect(parsed.files).toEqual([
      {
        namespace: "facts",
        path: "nested/a.txt",
        sandboxPath: "/rightmodeler/scratch/facts/nested/a.txt",
        bytes: 5,
      },
      {
        namespace: "facts",
        path: "z-safe.txt",
        sandboxPath: "/rightmodeler/scratch/facts/z-safe.txt",
        bytes: 4,
      },
    ]);
    expect(parsed.skipped).toEqual([
      {
        namespace: "facts",
        path: ".rightmodeler-store",
        bytes: 8,
        skipped: true,
      },
      {
        namespace: "facts",
        path: "escape.txt",
        bytes: 12,
        skipped: true,
      },
    ]);
  });

  it("fails loudly on malformed manifests and non-directory namespaces", () => {
    expect(() =>
      parseCloudCollectionManifest(
        "facts",
        "/scratch/facts",
        ["f", "0"].join("\0"),
      ),
    ).toThrow(/Malformed collection manifest/);
    expect(() =>
      parseCloudCollectionManifest(
        "facts",
        "/scratch/facts",
        `${["f", "0", ""].join("\0")}\0`,
      ),
    ).toThrow(/not a directory/);
  });

  it("collects under independent namespace caps and mirrors accepted files", async () => {
    const executor = createCloudExecutor({ maxBytesPerNamespace: 6 });
    const handle = await executor.launch(launchSpec());
    const [sandbox] = [...mocks.sandboxes.values()];
    if (sandbox === undefined) throw new Error("sandbox was not created");
    sandbox.manifest = [
      "d",
      "0",
      "",
      "f",
      "4",
      "a.txt",
      "f",
      "4",
      "b.txt",
      "",
    ].join("\0");
    sandbox.files.set("/rightmodeler/scratch/facts/a.txt", Buffer.from("aaaa"));
    sandbox.files.set(
      "/rightmodeler/scratch/metrics/a.txt",
      Buffer.from("mmmm"),
    );

    const result = await executor.collect(handle, {
      namespaces: ["facts", "metrics"],
      scratchHostPath: scratchPath,
    });

    expect(
      result.files.map((file) => [
        file.namespace,
        file.path,
        Buffer.from(file.contents).toString("utf8"),
      ]),
    ).toEqual([
      ["facts", "a.txt", "aaaa"],
      ["metrics", "a.txt", "mmmm"],
    ]);
    expect(result.skipped).toEqual([
      {
        namespace: "facts",
        path: "b.txt",
        bytes: 4,
        skipped: true,
      },
      {
        namespace: "metrics",
        path: "b.txt",
        bytes: 4,
        skipped: true,
      },
    ]);
  });

  it("rejects namespace traversal before contacting the sandbox", async () => {
    const executor = createCloudExecutor({ maxBytesPerNamespace: 10 });
    const handle = await executor.launch(launchSpec());

    await expect(
      executor.collect(handle, {
        namespaces: [".."],
        scratchHostPath: scratchPath,
      }),
    ).rejects.toThrow(/Invalid namespace/);
  });
});

describe("cloud network policy", () => {
  it("uses allow-all without a credential and an overwrite transform with one", () => {
    expect(buildCloudNetworkPolicy(undefined)).toBe("allow-all");
    expect(
      buildCloudNetworkPolicy({
        host: "ai-gateway.vercel.sh",
        headerName: "authorization",
        value: "Bearer key",
      }),
    ).toEqual({
      allow: {
        "ai-gateway.vercel.sh": [
          {
            transform: [{ headers: { authorization: "Bearer key" } }],
          },
        ],
        "*": [],
      },
    });
  });
});
