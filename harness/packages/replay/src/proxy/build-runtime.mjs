import { cp, mkdir } from "node:fs/promises";

const sourceRoot = new URL("../", import.meta.url);
const distRoot = new URL("../../dist/", import.meta.url);

await mkdir(new URL("proxy/", distRoot), { recursive: true });
await cp(
  new URL("proxy/proxy-runtime.mjs", sourceRoot),
  new URL("proxy/proxy-runtime.mjs", distRoot),
);
await cp(
  new URL("proxy/container-supervisor.mjs", sourceRoot),
  new URL("proxy/container-supervisor.mjs", distRoot),
);
