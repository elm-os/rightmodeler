import { readFile, writeFile } from "node:fs/promises";

import { createProgram } from "../src/cli.ts";
import { renderCommandsDoc } from "../src/commands-doc.ts";

const commandsPath = new URL("../docs/commands.md", import.meta.url);
const generated = renderCommandsDoc(createProgram().program);

if (process.argv.includes("--write")) {
  await writeFile(commandsPath, generated);
} else if (process.argv.includes("--check")) {
  const committed = await readFile(commandsPath, "utf8");
  if (committed !== generated) {
    throw new Error(
      "docs/commands.md is stale. Run `pnpm docs:generate` in @rightmodeler/cli.",
    );
  }
} else {
  throw new Error("Expected --write or --check");
}
