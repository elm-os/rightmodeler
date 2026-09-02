import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ensureModeBImage(fixturePath: string): Promise<string> {
  await execFileAsync("docker", ["version"], { encoding: "utf8" });
  const requirements = await readFile(join(fixturePath, "requirements.txt"));
  const digest = createHash("sha256")
    .update(requirements)
    .digest("hex")
    .slice(0, 12);
  const image = `rightmodeler-modeb-langgraph:${digest}`;
  try {
    await execFileAsync("docker", ["image", "inspect", image], {
      encoding: "utf8",
    });
    return image;
  } catch {
    // Build the pinned fixture runtime once when it is not cached locally.
  }
  const buildRoot = await mkdtemp(join(tmpdir(), "rightmodeler-modeb-image-"));
  try {
    const dockerfile = join(buildRoot, "Dockerfile");
    await writeFile(
      dockerfile,
      [
        "FROM node:24-bookworm-slim",
        "RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*",
        "COPY requirements.txt /tmp/requirements.txt",
        "RUN pip3 install --break-system-packages --no-cache-dir -r /tmp/requirements.txt",
        "",
      ].join("\n"),
      "utf8",
    );
    await execFileAsync(
      "docker",
      ["build", "--tag", image, "--file", dockerfile, fixturePath],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
  return image;
}
