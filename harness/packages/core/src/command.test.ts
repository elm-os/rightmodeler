import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cmdShimTarget, resolveCommand } from "./command.js";

// Shim bodies as npm, pnpm, Node and Volta write them on Windows.
const npmShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

const pnpmShim = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\\repo\\node_modules\\.pnpm\\prettier@3.9.4\\node_modules"
) ELSE (
  @SET "NODE_PATH=C:\\repo\\node_modules\\.pnpm\\prettier@3.9.4\\node_modules;%NODE_PATH%"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\prettier\\bin\\prettier.cjs" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\..\\prettier\\bin\\prettier.cjs" %*
)
`;

const pnpmExeShim = `@SETLOCAL
@"%~dp0\\..\\global\\v11\\8f98-1a1424a365a\\node_modules\\@pnpm\\exe\\pnpm.exe"   %*
`;

const nodeNpxShim = `:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"
)
IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (
  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"
)

"%NODE_EXE%" "%NPX_CLI_JS%" %*
`;

describe("cmdShimTarget", () => {
  it("finds the script an npm shim runs with node", () => {
    expect(cmdShimTarget(npmShim)).toEqual({
      path: "node_modules\\@openai\\codex\\bin\\codex.js",
      node: true,
    });
  });

  it("finds the script a pnpm shim runs with node", () => {
    expect(cmdShimTarget(pnpmShim)).toEqual({
      path: "..\\prettier\\bin\\prettier.cjs",
      node: true,
    });
  });

  it("finds the program a pnpm shim starts directly", () => {
    expect(cmdShimTarget(pnpmExeShim)).toEqual({
      path: "..\\global\\v11\\8f98-1a1424a365a\\node_modules\\@pnpm\\exe\\pnpm.exe",
      node: false,
    });
  });

  it("accepts an absolute target on another drive", () => {
    expect(
      cmdShimTarget('@node  "D:\\tools\\cli\\bin\\cli.js" %*\r\n'),
    ).toEqual({ path: "D:\\tools\\cli\\bin\\cli.js", node: true });
  });

  it("refuses shims that do not name a node script or a program", () => {
    expect(cmdShimTarget(nodeNpxShim)).toBeUndefined();
    expect(cmdShimTarget("@echo off\r\nvolta run %~n0 %*\r\n")).toBeUndefined();
    expect(
      cmdShimTarget(
        npmShim
          .replaceAll("node.exe", "sh.exe")
          .replace('"_prog=node"', '"_prog=sh"'),
      ),
    ).toBeUndefined();
    expect(
      cmdShimTarget('@node  "%~dp0\\..\\other\\run.cmd" %*\r\n'),
    ).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")(
  "resolveCommand off Windows",
  () => {
    it("returns the command unchanged", () => {
      expect(resolveCommand("codex")).toEqual({ file: "codex", args: [] });
    });
  },
);

describe.runIf(process.platform === "win32")(
  "resolveCommand on Windows",
  () => {
    const directories: string[] = [];

    afterEach(async () => {
      await Promise.all(
        directories
          .splice(0)
          .map((directory) => rm(directory, { recursive: true, force: true })),
      );
    });

    async function folder(files: Record<string, string>): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "rightmodeler-command-"));
      directories.push(root);
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(root, name, ".."), { recursive: true });
        await writeFile(join(root, name), text);
      }
      return root;
    }

    it("starts the script behind an npm or pnpm shim with node", async () => {
      const root = await folder({
        "bin/tool.cmd": '@node  "%~dp0\\..\\pkg\\cli.js" %*\r\n',
        "pkg/cli.js": "",
      });

      expect(resolveCommand("tool", { Path: join(root, "bin") })).toEqual({
        file: process.execPath,
        args: [join(root, "pkg", "cli.js")],
      });
    });

    it("searches PATH in order, and PATHEXT order within one folder", async () => {
      const first = await folder({ "tool.cmd": "", "tool.exe": "" });
      const second = await folder({ "other.exe": "" });
      const env = {
        PATH: `relative;"${first}";${second}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      };

      expect(resolveCommand("tool", env)).toEqual({
        file: join(first, "tool.EXE"),
        args: [],
      });
      expect(resolveCommand("other", env)).toEqual({
        file: join(second, "other.EXE"),
        args: [],
      });
    });

    it("runs an explicit script path with node and probes extensions", async () => {
      const root = await folder({
        "run.mjs": "",
        "bin/tool": "#!/bin/sh\n",
        "bin/tool.cmd": '@node  "%~dp0\\..\\run.mjs" %*\r\n',
      });

      expect(resolveCommand(join(root, "run.mjs"), {})).toEqual({
        file: process.execPath,
        args: [join(root, "run.mjs")],
      });
      expect(resolveCommand(join(root, "bin", "tool"), {})).toEqual({
        file: process.execPath,
        args: [join(root, "run.mjs")],
      });
    });

    it("names a missing command and a shim it cannot start", async () => {
      const root = await folder({
        "volta.cmd": "@echo off\r\nvolta run %~n0 %*\r\n",
      });

      expect(() => resolveCommand("absent", { PATH: root })).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(() => resolveCommand("volta", { PATH: root })).toThrow(
        expect.objectContaining({ code: "EINVAL" }),
      );
    });
  },
);
