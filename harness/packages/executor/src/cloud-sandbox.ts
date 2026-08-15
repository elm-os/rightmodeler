import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { assertSafeSegment } from "@rightmodeler/core";
import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";
import {
  HEARTBEAT_FILE,
  SCRATCH_CONTAINER_PATH,
  type CollectedFile,
  type DockerCollectRequest,
  type DockerCollectResult,
  type DockerHandle,
  type DockerLaunchSpec,
  type DockerStatus,
  type SkippedFile,
} from "./index.js";

export interface CloudModelCredential {
  /** Exact HTTPS destination host whose outbound requests receive the header. */
  readonly host: string;
  readonly headerName: string;
  /** Host-only secret. It is sent to the platform firewall, never the VM. */
  readonly value: string;
}

export interface CloudExecutorOptions {
  readonly maxBytesPerNamespace: number;
  readonly modelCredential?: CloudModelCredential;
}

export interface CloudExecutor {
  launch(spec: DockerLaunchSpec): Promise<DockerHandle>;
  status(handle: DockerHandle): Promise<DockerStatus>;
  collect(
    handle: DockerHandle,
    request: DockerCollectRequest,
  ): Promise<DockerCollectResult>;
  destroy(handle: DockerHandle): Promise<void>;
}

export type CloudAvailabilityReason =
  "credentials-unavailable" | "sdk-unavailable";

export type CloudAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: CloudAvailabilityReason;
      readonly message: string;
    };

type SandboxSdk = typeof import("@vercel/sandbox");

interface PendingFile {
  readonly namespace: string;
  readonly path: string;
  readonly sandboxPath: string;
  readonly bytes: number;
}

interface ParsedManifest {
  readonly files: readonly PendingFile[];
  readonly skipped: readonly SkippedFile[];
}

interface ActiveRun {
  readonly sandbox: Sandbox;
  readonly timeout: NodeJS.Timeout;
  exitCode?: number;
  failure?: unknown;
  timedOut: boolean;
}

interface CloudHandleData {
  readonly sandboxName: string;
  readonly commandId: string;
  readonly startedAt: string;
  readonly deadlineAt: number;
}

interface LocalEntry {
  readonly kind: "directory" | "file" | "symlink";
  readonly path: string;
  readonly mode: number;
  readonly contents?: Uint8Array;
  readonly target?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failureDetail(error: unknown): string {
  if (!isRecord(error)) return String(error);
  for (const key of ["stderr", "stdout", "message"] as const) {
    const value = error[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return String(error);
}

function accessCredentials():
  | {
      readonly teamId: string;
      readonly projectId: string;
      readonly token: string;
    }
  | undefined {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return undefined;
}

function hasCloudCredentials(): boolean {
  return (
    Boolean(process.env.VERCEL_OIDC_TOKEN) || accessCredentials() !== undefined
  );
}

function encodeHandle(data: CloudHandleData): DockerHandle {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

function decodeHandle(handle: DockerHandle): CloudHandleData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
  } catch {
    throw new Error(`Invalid cloud sandbox handle ${handle}`);
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.sandboxName !== "string" ||
    typeof parsed.commandId !== "string" ||
    typeof parsed.startedAt !== "string" ||
    typeof parsed.deadlineAt !== "number"
  ) {
    throw new Error(`Invalid cloud sandbox handle ${handle}`);
  }
  return {
    sandboxName: parsed.sandboxName,
    commandId: parsed.commandId,
    startedAt: parsed.startedAt,
    deadlineAt: parsed.deadlineAt,
  };
}

async function loadSdk(): Promise<SandboxSdk> {
  return import("@vercel/sandbox");
}

export async function detectCloudAvailability(): Promise<CloudAvailability> {
  try {
    await loadSdk();
  } catch (error) {
    return {
      available: false,
      reason: "sdk-unavailable",
      message: `@vercel/sandbox is unavailable: ${failureDetail(error)}`,
    };
  }
  if (!hasCloudCredentials()) {
    return {
      available: false,
      reason: "credentials-unavailable",
      message:
        "Set VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
    };
  }
  return { available: true };
}

function validateOptions(options: CloudExecutorOptions): void {
  if (
    !Number.isSafeInteger(options.maxBytesPerNamespace) ||
    options.maxBytesPerNamespace <= 0
  ) {
    throw new Error("maxBytesPerNamespace must be a positive safe integer");
  }
  const credential = options.modelCredential;
  if (credential === undefined) return;
  if (
    credential.host.length === 0 ||
    credential.host.includes("://") ||
    credential.host.includes("/")
  ) {
    throw new Error("modelCredential.host must be an exact hostname");
  }
  if (credential.headerName.trim().length === 0) {
    throw new Error("modelCredential.headerName must not be empty");
  }
  if (credential.value.length === 0) {
    throw new Error("modelCredential.value must not be empty");
  }
}

export function buildCloudNetworkPolicy(
  credential: CloudModelCredential | undefined,
): NetworkPolicy {
  if (credential === undefined) return "allow-all";
  // The platform firewall overwrites this header on matching HTTPS egress.
  // The wildcard preserves normal egress; the real value appears only in the
  // host-created policy, never in sandbox environment variables or files.
  return {
    allow: {
      [credential.host]: [
        {
          transform: [
            { headers: { [credential.headerName]: credential.value } },
          ],
        },
      ],
      "*": [],
    },
  };
}

async function listLocalEntries(root: string): Promise<readonly LocalEntry[]> {
  const rootStats = await lstat(root);
  if (rootStats.isFile()) {
    return [
      {
        kind: "file",
        path: "",
        mode: rootStats.mode & 0o777,
        contents: await readFile(root),
      },
    ];
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Cloud upload source ${root} is not a file or directory`);
  }

  const entries: LocalEntry[] = [];
  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath =
        relativeDirectory.length === 0
          ? child.name
          : posix.join(relativeDirectory, child.name);
      const absolutePath = join(directory, child.name);
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        entries.push({
          kind: "directory",
          path: relativePath,
          mode: stats.mode & 0o777,
        });
        await visit(absolutePath, relativePath);
      } else if (stats.isFile()) {
        entries.push({
          kind: "file",
          path: relativePath,
          mode: stats.mode & 0o777,
          contents: await readFile(absolutePath),
        });
      } else if (stats.isSymbolicLink()) {
        entries.push({
          kind: "symlink",
          path: relativePath,
          mode: stats.mode & 0o777,
          target: await readlink(absolutePath),
        });
      } else {
        throw new Error(
          `Cloud upload source ${absolutePath} has unsupported type`,
        );
      }
    }
  }
  await visit(root, "");
  return entries;
}

async function runChecked(
  sandbox: Sandbox,
  cmd: string,
  args: readonly string[],
): Promise<string> {
  const result = await sandbox.runCommand({ cmd, args: [...args] });
  if (result.exitCode !== 0) {
    throw new Error(
      `Cloud sandbox command ${JSON.stringify(cmd)} failed with exit code ${result.exitCode}: ${(await result.stderr()).trim()}`,
    );
  }
  return result.stdout();
}

async function uploadTree(
  sandbox: Sandbox,
  source: string,
  destination: string,
  readOnly: boolean,
): Promise<void> {
  const entries = await listLocalEntries(source);
  const rootStats = await lstat(source);
  if (rootStats.isDirectory()) {
    await runChecked(sandbox, "mkdir", ["-p", destination]);
  }
  for (const entry of entries) {
    const remotePath =
      entry.path.length === 0
        ? destination
        : posix.join(destination, entry.path);
    if (entry.kind === "directory") {
      await runChecked(sandbox, "mkdir", ["-p", remotePath]);
      await runChecked(sandbox, "chmod", [entry.mode.toString(8), remotePath]);
    } else if (entry.kind === "file") {
      await runChecked(sandbox, "mkdir", ["-p", posix.dirname(remotePath)]);
      await sandbox.writeFiles([
        {
          path: remotePath,
          content: entry.contents ?? new Uint8Array(),
          mode: entry.mode,
        },
      ]);
    } else {
      await runChecked(sandbox, "mkdir", ["-p", posix.dirname(remotePath)]);
      await runChecked(sandbox, "ln", [
        "-s",
        "--",
        entry.target ?? "",
        remotePath,
      ]);
    }
  }
  if (readOnly) await runChecked(sandbox, "chmod", ["-R", "a-w", destination]);
}

function validateManifestPath(path: string): boolean {
  if (path.length === 0) return true;
  try {
    for (const segment of path.split("/")) {
      assertSafeSegment(segment, "artifact path segment");
    }
    return true;
  } catch {
    return false;
  }
}

export function parseCloudCollectionManifest(
  namespace: string,
  namespacePath: string,
  manifest: string,
): ParsedManifest {
  const fields = manifest.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error(`Malformed collection manifest for namespace ${namespace}`);
  }

  const files: PendingFile[] = [];
  const skipped: SkippedFile[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const kind = fields[index];
    const bytesText = fields[index + 1];
    const path = fields[index + 2];
    if (kind === undefined || bytesText === undefined || path === undefined) {
      throw new Error(
        `Malformed collection manifest for namespace ${namespace}`,
      );
    }
    const bytes = Number(bytesText);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Malformed collection size for namespace ${namespace}`);
    }
    if (path === "") {
      if (kind === "d") continue;
      if (kind === "l") {
        skipped.push({ namespace, path, bytes, skipped: true });
        continue;
      }
      throw new Error(`Collection namespace ${namespace} is not a directory`);
    }
    if (!validateManifestPath(path) || kind === "l") {
      skipped.push({ namespace, path, bytes, skipped: true });
    } else if (kind === "f") {
      files.push({
        namespace,
        path,
        sandboxPath: posix.join(namespacePath, path),
        bytes,
      });
    } else if (kind !== "d") {
      skipped.push({ namespace, path, bytes, skipped: true });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skipped };
}

async function collectionManifest(
  sandbox: Sandbox,
  namespace: string,
): Promise<ParsedManifest> {
  const namespacePath = posix.join(SCRATCH_CONTAINER_PATH, namespace);
  const result = await sandbox.runCommand({
    cmd: "find",
    args: [namespacePath, "-xdev", "-printf", "%y\\0%s\\0%P\\0"],
  });
  if (result.exitCode !== 0) {
    const stderr = (await result.stderr()).trim();
    if (/No such file or directory/.test(stderr))
      return { files: [], skipped: [] };
    throw new Error(
      `Failed to list cloud collection namespace ${namespace}: ${stderr}`,
    );
  }
  return parseCloudCollectionManifest(
    namespace,
    namespacePath,
    await result.stdout(),
  );
}

async function heartbeatTime(sandbox: Sandbox): Promise<string | null> {
  const heartbeatPath = posix.join(SCRATCH_CONTAINER_PATH, HEARTBEAT_FILE);
  if (!(await sandbox.fs.exists(heartbeatPath))) return null;
  return (await sandbox.fs.lstat(heartbeatPath)).mtime.toISOString();
}

function assertCredentialIsBrokered(
  spec: DockerLaunchSpec,
  credential: CloudModelCredential | undefined,
): void {
  if (
    credential !== undefined &&
    Object.values(spec.env).includes(credential.value)
  ) {
    throw new Error(
      "The brokered model credential must not be present in sandbox environment variables",
    );
  }
}

export function createCloudExecutor(
  options: CloudExecutorOptions,
): CloudExecutor {
  validateOptions(options);
  const runs = new Map<DockerHandle, ActiveRun>();

  return {
    async launch(spec): Promise<DockerHandle> {
      assertCredentialIsBrokered(spec, options.modelCredential);
      if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
        throw new Error("timeoutMs must be a positive safe integer");
      }
      if (spec.command.length === 0) {
        throw new Error("Cloud sandbox commands must not be empty");
      }
      if ((spec.hostPorts?.length ?? 0) > 0) {
        throw new Error(
          "Cloud sandboxes cannot reach host.docker.internal; use a public HTTPS egress endpoint",
        );
      }
      if (Object.keys(spec.labels).length > 5) {
        throw new Error("Cloud sandboxes support at most five labels");
      }
      if (!hasCloudCredentials()) {
        throw new Error(
          "Cloud sandbox credentials are unavailable; set VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
        );
      }

      const sdk = await loadSdk().catch((error: unknown) => {
        throw new Error(
          `Failed to load @vercel/sandbox: ${failureDetail(error)}`,
        );
      });
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await sdk.Sandbox.create({
          ...accessCredentials(),
          image: spec.image,
          timeout: spec.timeoutMs + 60_000,
          persistent: false,
          env: { ...spec.env },
          tags: { ...spec.labels },
          networkPolicy: buildCloudNetworkPolicy(options.modelCredential),
        });
        for (const mount of spec.mounts) {
          await uploadTree(
            sandbox,
            await realpath(mount.hostPath),
            mount.containerPath,
            mount.readOnly,
          );
        }
        const scratchHostPath = await realpath(spec.scratchHostPath);
        await uploadTree(
          sandbox,
          scratchHostPath,
          SCRATCH_CONTAINER_PATH,
          false,
        );
        const command = await sandbox.runCommand({
          cmd: spec.command[0] ?? "",
          args: spec.command.slice(1),
          env: { ...spec.env },
          detached: true,
          timeoutMs: spec.timeoutMs,
        });
        const startedAt = new Date(command.startedAt).toISOString();
        const deadlineAt = command.startedAt + spec.timeoutMs;
        const handle = encodeHandle({
          sandboxName: sandbox.name,
          commandId: command.cmdId,
          startedAt,
          deadlineAt,
        });
        const run: ActiveRun = {
          sandbox,
          timeout: setTimeout(() => {
            run.timedOut = true;
          }, spec.timeoutMs),
          timedOut: false,
        };
        run.timeout.unref();
        runs.set(handle, run);
        void command.wait().then(
          (finished) => {
            clearTimeout(run.timeout);
            run.exitCode = finished.exitCode;
          },
          (error: unknown) => {
            clearTimeout(run.timeout);
            run.failure = error;
          },
        );
        return handle;
      } catch (error) {
        if (sandbox !== undefined)
          await sandbox.delete().catch(() => undefined);
        throw new Error(
          `Failed to launch cloud sandbox image ${JSON.stringify(spec.image)}: ${failureDetail(error)}`,
        );
      }
    },

    async status(handle): Promise<DockerStatus> {
      const handleData = decodeHandle(handle);
      const active = runs.get(handle);
      if (active?.failure !== undefined) {
        throw new Error(
          `Failed to inspect cloud sandbox ${handle}: ${failureDetail(active.failure)}`,
        );
      }
      const sandbox =
        active?.sandbox ??
        (await (
          await loadSdk()
        ).Sandbox.get({
          ...accessCredentials(),
          name: handleData.sandboxName,
          resume: false,
        }));
      const command = await sandbox
        .currentSession()
        .getCommand(handleData.commandId);
      const platformStopped = ["stopped", "failed", "aborted"].includes(
        sandbox.status,
      );
      const exitCode = active?.exitCode ?? command.exitCode;
      const state =
        exitCode === null && !platformStopped ? "running" : "exited";
      const timedOut =
        active?.timedOut === true ||
        (state === "exited" &&
          Date.now() >= handleData.deadlineAt &&
          (exitCode === null || exitCode === 137));
      return {
        state,
        ...(state === "exited" ? { exitCode: exitCode ?? 137 } : {}),
        oomKilled: false,
        timedOut,
        startedAt: handleData.startedAt,
        heartbeatAt: platformStopped ? null : await heartbeatTime(sandbox),
      };
    },

    async collect(handle, request): Promise<DockerCollectResult> {
      const handleData = decodeHandle(handle);
      const sandbox =
        runs.get(handle)?.sandbox ??
        (await (
          await loadSdk()
        ).Sandbox.get({
          ...accessCredentials(),
          name: handleData.sandboxName,
          resume: false,
        }));
      const namespaces = [...new Set(request.namespaces)];
      for (const namespace of namespaces) {
        assertSafeSegment(namespace, "namespace");
      }

      const pendingFiles: PendingFile[] = [];
      const skipped: SkippedFile[] = [];
      for (const namespace of namespaces) {
        const manifest = await collectionManifest(sandbox, namespace);
        pendingFiles.push(...manifest.files);
        skipped.push(...manifest.skipped);
      }

      const files: CollectedFile[] = [];
      const usedBytes = new Map<string, number>();
      for (const pending of pendingFiles) {
        const used = usedBytes.get(pending.namespace) ?? 0;
        const remaining = options.maxBytesPerNamespace - used;
        if (pending.bytes > remaining) {
          skipped.push({
            namespace: pending.namespace,
            path: pending.path,
            bytes: pending.bytes,
            skipped: true,
          });
          continue;
        }
        const contents = await sandbox.readFileToBuffer({
          path: pending.sandboxPath,
        });
        if (contents === null) {
          throw new Error(
            `Cloud collection file ${pending.sandboxPath} vanished`,
          );
        }
        const hostPath = join(
          request.scratchHostPath,
          pending.namespace,
          ...pending.path.split("/"),
        );
        await mkdir(dirname(hostPath), { recursive: true });
        await writeFile(hostPath, contents);
        files.push({
          namespace: pending.namespace,
          path: pending.path,
          bytes: contents.byteLength,
          contents,
        });
        usedBytes.set(pending.namespace, used + contents.byteLength);
      }
      return { files, skipped };
    },

    async destroy(handle): Promise<void> {
      const active = runs.get(handle);
      if (active !== undefined) {
        clearTimeout(active.timeout);
        await active.sandbox.delete();
        runs.delete(handle);
        return;
      }
      const handleData = decodeHandle(handle);
      try {
        const sandbox = await (
          await loadSdk()
        ).Sandbox.get({
          ...accessCredentials(),
          name: handleData.sandboxName,
          resume: false,
        });
        await sandbox.delete();
      } catch (error) {
        if (
          !isRecord(error) ||
          !isRecord(error.response) ||
          error.response.status !== 404
        ) {
          throw error;
        }
      }
    },
  };
}
