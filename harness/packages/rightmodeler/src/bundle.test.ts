import { execFile, spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

interface StubProvider {
  port: number;
  close(): Promise<void>;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("packed CLI bundle", () => {
  it("installs the tarball and drives the complete pipeline from the installed binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-bundle-"));
    temporaryDirectories.push(root);
    const packDirectory = join(root, "pack");
    const project = join(root, "project");
    const repo = join(root, "demo-app");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(project, { recursive: true }),
      cp(demoAppPath, repo, { recursive: true }),
    ]);
    await execFileAsync("git", [
      "-C",
      repo,
      "init",
      "--quiet",
      "--initial-branch",
      "main",
    ]);
    await execFileAsync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "fixture@example.com",
    ]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Fixture"]);
    await execFileAsync("git", ["-C", repo, "add", "."]);
    await execFileAsync("git", [
      "-C",
      repo,
      "commit",
      "--quiet",
      "--message",
      "Seed fixture",
    ]);

    await execFileAsync("pnpm", ["pack", "--pack-destination", packDirectory], {
      cwd: packageRoot,
      env: withoutColor(process.env),
      maxBuffer: 20 * 1024 * 1024,
    });
    const tarballs = (await readdir(packDirectory)).filter((name) =>
      name.endsWith(".tgz"),
    );
    expect(tarballs).toHaveLength(1);
    const tarball = join(packDirectory, tarballs[0]!);

    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({ name: "installed-cli-test", private: true })}\n`,
    );
    await execFileAsync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      {
        cwd: project,
        env: withoutColor(process.env),
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    // The published name is the bare, npx-friendly `rightmodeler`; only the workspace keeps
    // the scoped name to avoid colliding with the repo root package.
    const installedRoot = join(project, "node_modules/rightmodeler");
    const installedBinary = join(project, "node_modules/.bin/rightmodeler");
    expect(await realpath(installedBinary)).toBe(
      await realpath(join(installedRoot, "dist-bundle/cli.js")),
    );
    await assertPackedDocumentation(installedRoot);
    await Promise.all(
      [
        "dist-bundle/proxy/container-supervisor.mjs",
        "dist-bundle/proxy/headers.js",
        "dist-bundle/proxy/proxy-runtime.mjs",
        "dist-bundle/transport/stream.js",
      ].map((path) => access(join(installedRoot, path))),
    );

    const installedPackage = JSON.parse(
      await readFile(join(installedRoot, "package.json"), "utf8"),
    ) as { dependencies?: unknown; engines?: { node?: string } };
    expect(installedPackage.dependencies).toBeUndefined();
    expect(installedPackage.engines?.node).toBe(">=24");

    const help = await runInstalled(installedBinary, ["--help"], project);
    expect(help).toMatchObject({ code: 0, stderr: "" });
    expect(help.stdout).toContain("rightmodeler");

    const plan = await runInstalled(
      installedBinary,
      ["init", "--plan", "--output", "json", "--repo", repo],
      project,
    );
    expect(plan).toMatchObject({ code: 0, stderr: "" });
    const planOutput = JSON.parse(plan.stdout) as {
      executedStages: string[];
      recommendationExists: boolean;
    };
    expect(planOutput).toMatchObject({
      executedStages: [],
      recommendationExists: false,
    });

    const corpus = await runInstalled(
      installedBinary,
      [
        "init",
        "--through",
        "corpus",
        "--traces",
        tracesPath,
        "--output",
        "json",
        "--repo",
        repo,
      ],
      project,
    );
    expect(corpus).toMatchObject({ code: 0, stderr: "" });
    const corpusOutput = JSON.parse(corpus.stdout) as {
      executedStages: string[];
    };
    expect(corpusOutput.executedStages).toEqual([
      "scan",
      "ingest",
      "reconcile",
      "scrub",
      "corpus",
    ]);

    const stub = await startStub();
    try {
      const full = await runInstalled(
        installedBinary,
        [
          "init",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_STUB_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        project,
        { RIGHTMODELER_STUB_API_KEY: "local-stub-placeholder" },
      );
      expect(full).toMatchObject({ code: 0, stderr: "" });
      const fullOutput = JSON.parse(full.stdout) as {
        executedStages: string[];
      };
      expect(fullOutput).toMatchObject({
        executedStages: expect.arrayContaining([
          "shortlist",
          "replay",
          "aggregate",
          "confirm",
          "report",
        ]),
      });
    } finally {
      await stub.close();
    }

    await access(join(repo, ".rightmodeler/project/reports/report.md"));
  }, 180_000);
});

async function startStub(): Promise<StubProvider> {
  const module = (await import(stubModuleUrl)) as StubProviderModule;
  return module.startStubProvider({ port: 0 });
}

function runInstalled(
  binary: string,
  args: readonly string[],
  cwd: string,
  addedEnv: NodeJS.ProcessEnv = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      env: { ...withoutColor(process.env), ...addedEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 10, stdout, stderr });
    });
  });
}

async function assertPackedDocumentation(installedRoot: string): Promise<void> {
  const markdownFiles = await collectMarkdown(installedRoot);
  expect(
    markdownFiles.map((path) => relative(installedRoot, path)).sort(),
  ).toEqual([
    "README.md",
    "docs/commands.md",
    "docs/evaluators.md",
    "docs/exit-codes.md",
    "docs/getting-started.md",
    "docs/modeb.md",
  ]);

  for (const markdownPath of markdownFiles) {
    const markdown = await readFile(markdownPath, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1]!;
      expect(link, relative(installedRoot, markdownPath)).not.toMatch(
        /^(?:[a-z]+:|\/\/)/i,
      );
      expect(isAbsolute(link), link).toBe(false);
      const target = link.split("#", 1)[0]!;
      if (target.length === 0) continue;
      const resolved = resolve(dirname(markdownPath), target);
      const packageRelative = relative(installedRoot, resolved);
      expect(
        packageRelative === ".." ||
          packageRelative.startsWith(`..${sep}`) ||
          isAbsolute(packageRelative),
        `${relative(installedRoot, markdownPath)}: ${link}`,
      ).toBe(false);
      expect(
        (await stat(resolved)).isFile(),
        `${relative(installedRoot, markdownPath)}: ${link}`,
      ).toBe(true);
    }
  }
}

async function collectMarkdown(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path);
    }
  }
  await visit(root);
  return result;
}

function withoutColor(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.FORCE_COLOR;
  delete result.NO_COLOR;
  return result;
}
