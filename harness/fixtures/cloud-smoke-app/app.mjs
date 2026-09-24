// Dependency-free Mode B workload for the live cloud smoke test (Node 24). It makes one metered
// chat call through the in-sandbox proxy and prints the terminal envelope as its last line.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { caseId, input } = JSON.parse(await readFile(process.argv[2], "utf8"));
const { mode, step, model } = input;

const response = await fetch(
  `${process.env.OPENAI_BASE_URL}/chat/completions`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "x-rm-step": step,
      "x-rm-call": randomUUID(),
    },
    body: JSON.stringify({
      // The proxy swaps this incumbent id for the swap-policy candidate.
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word ok." }],
    }),
  },
);
const completion = await response.json();

if (mode === "oversize") {
  // Larger than the 16 MiB namespace cap, so collection skips it without failing the case.
  const workload = join(process.env.RM_SCRATCH, "workload");
  await mkdir(workload, { recursive: true });
  await writeFile(
    join(workload, "oversize.bin"),
    Buffer.alloc(17 * 1024 * 1024),
  );
}

console.log(
  JSON.stringify({
    runId: process.env.RM_RUN_ID,
    caseId,
    executionId: process.env.RM_EXECUTION_ID,
    finalOutput: completion.choices?.[0]?.message?.content ?? null,
  }),
);
