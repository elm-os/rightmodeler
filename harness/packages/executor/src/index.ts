import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertSafeSegment } from "@rightmodeler/core";

const execFileAsync = promisify(execFile);
const dockerOutputLimit = 10 * 1024 * 1024;

export const SCRATCH_CONTAINER_PATH = "/rightmodeler/scratch";
export const HEARTBEAT_FILE = ".heartbeat";

export type DockerHandle = string;

export interface DockerMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface DockerHostPort {
  readonly containerHost: "host.docker.internal";
  readonly note: string;
}

export interface DockerLaunchSpec {
  readonly image: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: readonly DockerMount[];
  readonly scratchHostPath: string;
  readonly timeoutMs: number;
  readonly hostPorts?: readonly DockerHostPort[];
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerStatus {
  readonly state: "created" | "running" | "exited";
  readonly exitCode?: number;
  readonly oomKilled: boolean;
  readonly startedAt: string;
  readonly heartbeatAt: string | null;
}

export interface DockerCollectRequest {
  readonly namespaces: readonly string[];
}

export interface CollectedFile {
  readonly namespace: string;
  readonly path: string;
  readonly bytes: number;
  readonly contents: Uint8Array;
}

export interface SkippedFile {
  readonly namespace: string;
  readonly path: string;
  readonly bytes: number;
  readonly skipped: true;
}

export interface DockerCollectResult {
  readonly files: readonly CollectedFile[];
  readonly skipped: readonly SkippedFile[];
}

export interface DockerExecutorOptions {
  readonly maxBytesPerNamespace: number;
}

export interface DockerExecutor {
  launch(spec: DockerLaunchSpec): Promise<DockerHandle>;
  status(handle: DockerHandle): Promise<DockerStatus>;
  collect(
    handle: DockerHandle,
    request: DockerCollectRequest,
  ): Promise<DockerCollectResult>;
  destroy(handle: DockerHandle): Promise<void>;
}

interface ContainerInspect {
  readonly createdAt: string;
  readonly state: {
    readonly status: string;
    readonly exitCode: number;
    readonly oomKilled: boolean;
    readonly startedAt: string;
  };
  readonly mounts: readonly {
    readonly source: string;
    readonly destination: string;
  }[];
}

interface PendingFile {
  readonly namespace: string;
  readonly path: string;
  readonly hostPath: string;
  readonly bytes: number;
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

async function runDocker(args: readonly string[]): Promise<string> {
  const result = await execFileAsync("docker", [...args], {
    encoding: "utf8",
    maxBuffer: dockerOutputLimit,
  });
  return result.stdout.trim();
}

function parseContainerInspect(
  output: string,
  handle: DockerHandle,
): ContainerInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error(`Docker returned invalid inspect JSON for ${handle}`);
  }
  if (!Array.isArray(parsed) || !isRecord(parsed[0])) {
    throw new Error(`Docker returned invalid inspect data for ${handle}`);
  }

  const item = parsed[0];
  const state = item.State;
  const mounts = item.Mounts;
  if (
    typeof item.Created !== "string" ||
    !isRecord(state) ||
    typeof state.Status !== "string" ||
    typeof state.ExitCode !== "number" ||
    typeof state.OOMKilled !== "boolean" ||
    typeof state.StartedAt !== "string" ||
    !Array.isArray(mounts)
  ) {
    throw new Error(`Docker returned invalid inspect data for ${handle}`);
  }

  const parsedMounts = mounts.map((mount) => {
    if (
      !isRecord(mount) ||
      typeof mount.Source !== "string" ||
      typeof mount.Destination !== "string"
    ) {
      throw new Error(`Docker returned invalid mount data for ${handle}`);
    }
    return { source: mount.Source, destination: mount.Destination };
  });

  return {
    createdAt: item.Created,
    state: {
      status: state.Status,
      exitCode: state.ExitCode,
      oomKilled: state.OOMKilled,
      startedAt: state.StartedAt,
    },
    mounts: parsedMounts,
  };
}

async function inspectContainer(
  handle: DockerHandle,
): Promise<ContainerInspect> {
  let output: string;
  try {
    output = await runDocker(["inspect", handle]);
  } catch (error) {
    throw new Error(
      `Failed to inspect Docker container ${handle}: ${failureDetail(error)}`,
    );
  }
  return parseContainerInspect(output, handle);
}

function scratchHostPath(
  inspect: ContainerInspect,
  handle: DockerHandle,
): string {
  const mount = inspect.mounts.find(
    (candidate) => candidate.destination === SCRATCH_CONTAINER_PATH,
  );
  if (mount === undefined) {
    throw new Error(`Docker container ${handle} has no scratch mount`);
  }
  return mount.source;
}

async function heartbeatTime(scratchPath: string): Promise<string | null> {
  try {
    return (await lstat(join(scratchPath, HEARTBEAT_FILE))).mtime.toISOString();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function publicState(status: string): DockerStatus["state"] {
  if (status === "created") return "created";
  if (status === "running" || status === "paused" || status === "restarting") {
    return "running";
  }
  if (status === "exited" || status === "dead" || status === "removing") {
    return "exited";
  }
  throw new Error(
    `Docker returned unknown container state ${JSON.stringify(status)}`,
  );
}

function mountArgument(mount: DockerMount): string {
  const fields = [
    "type=bind",
    `source=${mount.hostPath}`,
    `target=${mount.containerPath}`,
  ];
  if (mount.readOnly) fields.push("readonly");
  return fields.join(",");
}

function isMissingContainer(error: unknown): boolean {
  return /No such (?:object|container)/i.test(failureDetail(error));
}

function isStoppedContainer(error: unknown): boolean {
  return /is not running/i.test(failureDetail(error));
}

async function listNamespaceFiles(
  namespace: string,
  namespacePath: string,
): Promise<PendingFile[]> {
  let namespaceStat;
  try {
    namespaceStat = await lstat(namespacePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  if (namespaceStat.isSymbolicLink()) {
    throw new Error(`Refusing to collect symbolic link namespace ${namespace}`);
  }
  if (!namespaceStat.isDirectory()) {
    throw new Error(`Collection namespace ${namespace} is not a directory`);
  }

  const files: PendingFile[] = [];
  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertSafeSegment(entry.name, "artifact path segment");
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      const hostPath = join(directory, entry.name);
      const stats = await lstat(hostPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Refusing to collect symbolic link ${namespace}/${relativePath}`,
        );
      }
      if (stats.isDirectory()) {
        await visit(hostPath, relativePath);
      } else if (stats.isFile()) {
        files.push({
          namespace,
          path: relativePath,
          hostPath,
          bytes: stats.size,
        });
      }
    }
  }

  await visit(namespacePath, "");
  return files;
}

export async function ensureImage(image: string): Promise<void> {
  try {
    await runDocker(["image", "inspect", image]);
    return;
  } catch {
    // A missing image is expected here; pull below reports the actionable error.
  }

  try {
    await runDocker(["image", "pull", image]);
  } catch (error) {
    throw new Error(
      `Failed to pull Docker image ${JSON.stringify(image)}: ${failureDetail(error)}`,
    );
  }
}

/**
 * Creates a fresh Docker container for every launch. Docker Desktop supplies
 * host.docker.internal on Darwin; native Linux needs the host-gateway mapping.
 * Killing the container at the deadline replaces host process-group handling:
 * Docker terminates the complete process tree in the container.
 */
export function createDockerExecutor(
  options: DockerExecutorOptions,
): DockerExecutor {
  if (
    !Number.isSafeInteger(options.maxBytesPerNamespace) ||
    options.maxBytesPerNamespace < 0
  ) {
    throw new Error("maxBytesPerNamespace must be a non-negative integer");
  }

  const timeoutMonitors = new Map<DockerHandle, NodeJS.Timeout>();
  const timeoutErrors = new Map<DockerHandle, Error>();

  function clearMonitor(handle: DockerHandle): void {
    const monitor = timeoutMonitors.get(handle);
    if (monitor !== undefined) clearTimeout(monitor);
    timeoutMonitors.delete(handle);
  }

  async function killAtTimeout(handle: DockerHandle): Promise<void> {
    try {
      await runDocker(["kill", handle]);
    } catch (error) {
      if (isMissingContainer(error) || isStoppedContainer(error)) return;
      timeoutErrors.set(
        handle,
        new Error(
          `Failed to kill timed-out Docker container ${handle}: ${failureDetail(error)}`,
        ),
      );
    } finally {
      timeoutMonitors.delete(handle);
    }
  }

  return {
    async launch(spec): Promise<DockerHandle> {
      if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
        throw new Error("timeoutMs must be a positive integer");
      }
      await ensureImage(spec.image);

      const resolvedMounts = await Promise.all(
        spec.mounts.map(async (mount) => ({
          ...mount,
          hostPath: await realpath(mount.hostPath),
        })),
      );
      const resolvedScratchHostPath = await realpath(spec.scratchHostPath);

      const args = ["run", "--detach", "--rm=false"];
      if (process.platform === "linux") {
        args.push("--add-host", "host.docker.internal:host-gateway");
      }
      for (const [name, value] of Object.entries(spec.env).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        args.push("--env", `${name}=${value}`);
      }
      for (const mount of resolvedMounts) {
        args.push("--mount", mountArgument(mount));
      }
      args.push(
        "--mount",
        mountArgument({
          hostPath: resolvedScratchHostPath,
          containerPath: SCRATCH_CONTAINER_PATH,
          readOnly: false,
        }),
      );
      for (const [name, value] of Object.entries(spec.labels).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        args.push("--label", `${name}=${value}`);
      }
      args.push(spec.image, ...spec.command);

      let handle: DockerHandle;
      try {
        handle = await runDocker(args);
      } catch (error) {
        throw new Error(
          `Failed to launch Docker image ${JSON.stringify(spec.image)}: ${failureDetail(error)}`,
        );
      }
      if (handle.length === 0) {
        throw new Error(
          `Docker returned no container ID for image ${JSON.stringify(spec.image)}`,
        );
      }

      const monitor = setTimeout(() => {
        void killAtTimeout(handle);
      }, spec.timeoutMs);
      monitor.unref();
      timeoutMonitors.set(handle, monitor);
      return handle;
    },

    async status(handle): Promise<DockerStatus> {
      const timeoutError = timeoutErrors.get(handle);
      if (timeoutError !== undefined) throw timeoutError;

      const inspected = await inspectContainer(handle);
      const state = publicState(inspected.state.status);
      if (state === "exited") clearMonitor(handle);
      const startedAt = inspected.state.startedAt.startsWith("0001-")
        ? inspected.createdAt
        : inspected.state.startedAt;
      return {
        state,
        ...(state === "exited" ? { exitCode: inspected.state.exitCode } : {}),
        oomKilled: inspected.state.oomKilled,
        startedAt,
        heartbeatAt: await heartbeatTime(scratchHostPath(inspected, handle)),
      };
    },

    async collect(handle, request): Promise<DockerCollectResult> {
      const namespaces = [...new Set(request.namespaces)];
      for (const namespace of namespaces) {
        assertSafeSegment(namespace, "namespace");
      }

      const inspected = await inspectContainer(handle);
      const scratchPath = scratchHostPath(inspected, handle);
      const pendingFiles: PendingFile[] = [];
      for (const namespace of namespaces) {
        pendingFiles.push(
          ...(await listNamespaceFiles(
            namespace,
            join(scratchPath, namespace),
          )),
        );
      }

      const files: CollectedFile[] = [];
      const skipped: SkippedFile[] = [];
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

        const contents = await readFile(pending.hostPath);
        if (contents.byteLength > remaining) {
          skipped.push({
            namespace: pending.namespace,
            path: pending.path,
            bytes: contents.byteLength,
            skipped: true,
          });
          continue;
        }
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
      clearMonitor(handle);
      try {
        await runDocker(["rm", "--force", handle]);
      } catch (error) {
        if (!isMissingContainer(error)) {
          throw new Error(
            `Failed to destroy Docker container ${handle}: ${failureDetail(error)}`,
          );
        }
      }
      timeoutErrors.delete(handle);
    },
  };
}
