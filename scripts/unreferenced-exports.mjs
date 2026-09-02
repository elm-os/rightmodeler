import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const scanRoots = ["harness/packages", "harness/apps/agent"];
const skipDirectories = new Set([
  "node_modules",
  "dist",
  "dist-bundle",
  "dist-bundle.staging",
]);

// Keys are "<repo-relative path>#<export name>", values the reason to keep an
// export nothing in the workspace consumes.
const allowed = new Map();

function sourceFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || skipDirectories.has(entry.name))
        continue;
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}

const files = scanRoots.flatMap((root) => sourceFiles(join(repoRoot, root)));
const sources = new Map(
  files.map((file) => [file, readFileSync(file, "utf8")]),
);
const declaration =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

const unreferenced = [];
for (const [file, source] of sources) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (name === "index.ts" || /\.(test|eval)\.ts$/.test(name)) continue;
  const key = relative(repoRoot, file);
  for (const match of source.matchAll(declaration)) {
    const exported = match[1];
    if (allowed.has(`${key}#${exported}`)) continue;
    const word = new RegExp(`\\b${exported}\\b`);
    let referenced = false;
    for (const [other, otherSource] of sources) {
      if (other !== file && word.test(otherSource)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) unreferenced.push(`${key}: ${exported}`);
  }
}

if (unreferenced.length > 0) {
  console.error(
    `${unreferenced.length} exported value(s) referenced by no other source file:`,
  );
  for (const entry of unreferenced.sort()) console.error(`  ${entry}`);
  console.error(
    "Drop the export keyword, delete the symbol, or add it to the allowlist with a reason.",
  );
  process.exit(1);
}

console.log(`checked ${files.length} source files, no unreferenced exports`);
