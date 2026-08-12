import { existsSync, readFileSync, readdirSync } from "node:fs";
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

function packageDependencyNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [];
  return Object.keys(value);
}

function pythonManifestHas(content: string, dependency: string): boolean {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|["'\\s])${escaped}(?=["'\\s=<>!~;,\\[]|$)`,
    "im",
  ).test(content);
}

export function detectTech(rootDir: string): DetectedTech {
  const absoluteRoot = resolve(rootDir);
  const dependencies: DetectedAiDependency[] = [];
  const languages = new Set<DetectedLanguage>();

  if (!existsSync(absoluteRoot)) return { languages: [], aiDependencies: [] };

  for (const manifest of manifests(absoluteRoot)) {
    const manifestPath = relative(absoluteRoot, manifest).split(sep).join("/");
    const name = manifest.slice(manifest.lastIndexOf(sep) + 1);
    const content = readFileSync(manifest, "utf8");
    if (name === "package.json") {
      languages.add("javascript");
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error(`Expected an object in ${manifestPath}`);
      }
      const packageJson = parsed as Record<string, unknown>;
      const names = new Set([
        ...packageDependencyNames(packageJson.dependencies),
        ...packageDependencyNames(packageJson.devDependencies),
        ...packageDependencyNames(packageJson.peerDependencies),
      ]);
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
    for (const dependency of pythonDependencies) {
      if (pythonManifestHas(content, dependency)) {
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
