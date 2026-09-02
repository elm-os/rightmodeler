import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { IGNORED_DIRECTORIES } from "./ignored-directories.js";

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
  "crewai",
  "autogen",
] as const;
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
        if (!IGNORED_DIRECTORIES.has(entry.name))
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

const specifierName = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)/;

function canonicalDependency(name: string): string {
  const lower = name.toLowerCase();
  if (/^langchain[-_]/.test(lower)) return "langchain";
  if (/^crewai(?:[-_]|$)/.test(lower)) return "crewai";
  if (/^(?:py)?autogen(?:[-_]|$)/.test(lower)) return "autogen";
  return lower;
}

function requirementsDependencies(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const specifier = line.replace(/#.*/, "").trim();
    if (specifier === "" || specifier.startsWith("-")) continue;
    const name = specifierName.exec(specifier)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function pyprojectDependencies(content: string): string[] {
  const names: string[] = [];
  let table = "";
  let inArray = false;
  for (const rawLine of content.split("\n")) {
    let line = rawLine.replace(/#.*/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      table = header[1]!.trim();
      inArray = false;
      continue;
    }
    if (
      /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(table)
    ) {
      const key = /^(?:"([^"]+)"|([A-Za-z0-9][A-Za-z0-9._-]*))\s*=/.exec(line);
      if (key !== null) names.push(key[1] ?? key[2]!);
      continue;
    }
    if (table !== "project" && table !== "project.optional-dependencies")
      continue;
    if (!inArray) {
      const assignment = /^(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=\s*\[(.*)$/.exec(
        line,
      );
      if (assignment === null) continue;
      if (
        table === "project" &&
        (assignment[1] ?? assignment[2]) !== "dependencies"
      )
        continue;
      inArray = true;
      line = assignment[3]!;
    }
    for (const match of line.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g))
      names.push(match[1]!);
    if (line.replace(/"[^"]*"|'[^']*'/g, "").includes("]")) inArray = false;
  }
  return names;
}

function pythonManifestDependencies(
  name: string,
  content: string,
): Set<string> {
  const found =
    name === "pyproject.toml"
      ? pyprojectDependencies(content)
      : requirementsDependencies(content);
  return new Set(found.map(canonicalDependency));
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
      } catch {
        continue;
      }
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
    const names = pythonManifestDependencies(name, content);
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
