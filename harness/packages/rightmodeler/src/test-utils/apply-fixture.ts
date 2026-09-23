import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tracesPath = fileURLToPath(
  new URL("../../../../fixtures/traces/otel-genai.json", import.meta.url),
);

export async function narrowFixtureForApply(
  repo: string,
  filteredTracesPath: string,
): Promise<void> {
  await Promise.all([
    rm(join(repo, "config"), { recursive: true, force: true }),
    rm(join(repo, "requirements.txt"), { force: true }),
    rm(join(repo, "src", "model-notes.ts"), { force: true }),
    rm(join(repo, "src", "support.py"), { force: true }),
    rm(join(repo, "src", "triage.py"), { force: true }),
    rm(join(repo, "src", "summarize-stream.ts"), { force: true }),
  ]);
  await writeFile(
    join(repo, "src", "summarize.ts"),
    [
      'import { generateText } from "ai";',
      "",
      "export async function summarize(article: string) {",
      "  return generateText({",
      '    model: "acme/large-1",',
      '    system: "Summarize the article faithfully in two concise sentences.",',
      "    prompt: article,",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "src", "extract.ts"),
    [
      'import { generateText } from "ai";',
      "",
      "export async function extractContact(message: string) {",
      "  return generateText({",
      '    model: "acme/max-1",',
      "    prompt: `Extract the contact request: ${message}`,",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ dependencies: { ai: "*" } }, null, 2)}\n`,
  );
  const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
    attributes?: Record<string, unknown>;
  }>;
  const summarizeTraces = traces
    .filter(
      ({ attributes }) => attributes?.["rightmodeler.family"] === "summarize",
    )
    .map((trace, index) =>
      index % 2 === 0
        ? trace
        : {
            ...trace,
            attributes: {
              ...trace.attributes,
              "gen_ai.request.model": "acme/max-1",
              "gen_ai.response.model": "acme/max-1",
            },
          },
    );
  await mkdir(dirname(filteredTracesPath), { recursive: true });
  await writeFile(filteredTracesPath, JSON.stringify(summarizeTraces));
  await execFileAsync("git", ["-C", repo, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "commit",
    "--message",
    "Narrow apply fixture",
  ]);
}
