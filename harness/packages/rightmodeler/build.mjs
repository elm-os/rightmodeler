import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(packageRoot, "dist-bundle");
const publishRoot = resolve(packageRoot, "dist/publish");
const replayDriver = resolve(packageRoot, "../replay/dist/driver-modeb.js");
const replayRuntime = resolve(packageRoot, "../replay/dist/proxy");
const bundleRuntimeResolver = `function replayRuntimeRoot() {
  return dirname(fileURLToPath(import.meta.url));
}`;

const bundleRuntimePlugin = {
  name: "bundle-runtime-root",
  setup(context) {
    context.onLoad({ filter: /driver-modeb\.js$/ }, async (args) => {
      if (resolve(args.path) !== replayDriver) return undefined;
      const source = await readFile(args.path, "utf8");
      const startMarker = "function replayRuntimeRoot() {";
      const endMarker = "\n}\nasync function prepareScratch";
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start);
      if (
        start === -1 ||
        end === -1 ||
        source.indexOf(startMarker, start + startMarker.length) !== -1
      ) {
        throw new Error(`Expected one replay runtime resolver in ${args.path}`);
      }
      return {
        contents: `${source.slice(0, start)}${bundleRuntimeResolver}${source.slice(end + 2)}`,
        loader: "js",
      };
    });
  },
};

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true });

await build({
  entryPoints: [resolve(packageRoot, "src/cli.ts")],
  outfile: resolve(bundleRoot, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  plugins: [bundleRuntimePlugin],
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  sourcemap: false,
});

await chmod(resolve(bundleRoot, "cli.js"), 0o755);
await mkdir(resolve(bundleRoot, "proxy"), { recursive: true });
await mkdir(resolve(bundleRoot, "transport"), { recursive: true });
await Promise.all([
  cp(
    resolve(replayRuntime, "container-supervisor.mjs"),
    resolve(bundleRoot, "proxy/container-supervisor.mjs"),
  ),
  cp(
    resolve(replayRuntime, "proxy-runtime.mjs"),
    resolve(bundleRoot, "proxy/proxy-runtime.mjs"),
  ),
  cp(
    resolve(replayRuntime, "headers.js"),
    resolve(bundleRoot, "proxy/headers.js"),
  ),
  cp(
    resolve(replayRuntime, "../transport/stream.js"),
    resolve(bundleRoot, "transport/stream.js"),
  ),
]);

const publishManifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
delete publishManifest.devDependencies;
delete publishManifest.publishConfig;
delete publishManifest.scripts;

await rm(publishRoot, { recursive: true, force: true });
await mkdir(publishRoot, { recursive: true });
await Promise.all([
  cp(bundleRoot, resolve(publishRoot, "dist-bundle"), { recursive: true }),
  cp(resolve(packageRoot, "docs"), resolve(publishRoot, "docs"), {
    recursive: true,
  }),
  cp(resolve(packageRoot, "README.md"), resolve(publishRoot, "README.md")),
  cp(resolve(packageRoot, "../../../LICENSE"), resolve(publishRoot, "LICENSE")),
  writeFile(
    resolve(publishRoot, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
  ),
]);
