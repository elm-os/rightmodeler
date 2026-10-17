import { symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { resolveCommand } from "@rightmodeler/core";

// A fake command named `name` in `dir` that runs the node script `script`: a symlink on
// POSIX, and on Windows the kind of .cmd launcher npm installs.
export async function linkFakeCli(
  dir: string,
  name: string,
  script: string,
): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(join(dir, `${name}.cmd`), `@node "${script}" %*\r\n`);
  } else {
    await symlink(script, join(dir, name));
  }
}

// A fake command named `name` in `dir` whose node script is `source`, which starts with a
// `#!/usr/bin/env node` line.
export async function writeFakeCli(
  dir: string,
  name: string,
  source: string,
): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(join(dir, `${name}.js`), source);
    await linkFakeCli(dir, name, join(dir, `${name}.js`));
  } else {
    await writeFile(join(dir, name), source, { mode: 0o755 });
  }
}

// A PATH that finds only `dirs` plus the system tools tests rely on, such as git.
export function hermeticPath(...dirs: string[]): string {
  const system =
    process.platform === "win32"
      ? [dirname(resolveCommand("git").file)]
      : ["/usr/bin", "/bin"];
  return [...dirs, ...system].join(delimiter);
}
