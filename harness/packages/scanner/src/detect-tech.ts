import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export type DetectedLanguage = "javascript" | "python";

export interface DetectedAiDependency {
  readonly language: DetectedLanguage;
  readonly name: string;
  readonly manifestPath: string;
}

export interface DetectedTech {
  readonly languages: readonly DetectedLanguage[];
  readonly aiDependencies: readonly DetectedAiDependency[];
}

const nodeDependencies = new Set([
  "ai",
  "openai",
  "@anthropic-ai/sdk",
  "langchain",
]);
const pythonDependencies = [
  "openai",
  "anthropic",
  "litellm",
  "langchain",
  "langgraph",
] as const;
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  ".venv",
  "build",
  "__pycache__",
]);
const manifestNames = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
]);

function manifests(rootDir: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          visit(join(directory, entry.name));
      } else if (entry.isFile() && manifestNames.has(entry.name)) {
        found.push(join(directory, entry.name));
      }
    }
  };
  visit(rootDir);
  return found.sort();
}

function packageDependencyNames(value: unknown, field?: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [];
  if (field !== undefined) {
    return packageDependencyNames(
      Object.getOwnPropertyDescriptor(value, field)?.value,
    );
  }
  return Object.keys(value);
}

function pythonManifestDependencies(content: string): Set<string> {
  const withoutComments = content
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join("\n");
  const names = new Set<string>();
  const pattern =
    /(?:^|["'\s])([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s*(?:[<>=!~;,\["']|$))/gim;
  for (const match of withoutComments.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    names.add(/^langchain[-_]/.test(name) ? "langchain" : name);
  }
  return names;
}

export function detectTech(rootDir: string): DetectedTech {
  const absoluteRoot = resolve(rootDir);
  const dependencies: DetectedAiDependency[] = [];
  const languages = new Set<DetectedLanguage>();

  for (const manifest of manifests(absoluteRoot)) {
    const manifestPath = relative(absoluteRoot, manifest).split(sep).join("/");
    const name = manifest.slice(manifest.lastIndexOf(sep) + 1);
    const content = readFileSync(manifest, "utf8");
    if (name === "package.json") {
      languages.add("javascript");
      const parsed: unknown = JSON.parse(content);
      const names = new Set(
        ["dependencies", "devDependencies", "peerDependencies"].flatMap(
          (field) => packageDependencyNames(parsed, field),
        ),
      );
      for (const dependency of [...nodeDependencies].sort()) {
        if (names.has(dependency)) {
          dependencies.push({
            language: "javascript",
            name: dependency,
            manifestPath,
          });
        }
      }
      continue;
    }

    languages.add("python");
    const names = pythonManifestDependencies(content);
    for (const dependency of pythonDependencies) {
      if (names.has(dependency)) {
        dependencies.push({
          language: "python",
          name: dependency,
          manifestPath,
        });
      }
    }
  }

  return {
    languages: [...languages].sort(),
    aiDependencies: dependencies.sort(
      (left, right) =>
        left.language.localeCompare(right.language) ||
        left.name.localeCompare(right.name) ||
        left.manifestPath.localeCompare(right.manifestPath),
    ),
  };
}
