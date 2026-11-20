// Markdown twin of the / route (src/app/page.tsx and the hero, sources bar, thesis band, platform,
// testimonial band, and CTA band sections it composes). Keep the two in sync.
import { CASE_STUDIES } from "@/content/case-studies";
import { ILLUSTRATIVE_SCORECARD, TRACE_SOURCES } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

// The testimonial band renders these fields from the same registry, so the twin cannot drift.
const testimonials = CASE_STUDIES.map(({ slug, testimonial }) =>
  [
    `> "${testimonial.quote}"`,
    `${testimonial.name}, ${testimonial.role}`,
    ...(testimonial.evidenceNote ? [testimonial.evidenceNote] : []),
    `Read the story: /case-study/${slug}`,
  ].join("\n\n"),
).join("\n\n");

export const markdown = `# The human in the loop is the bottleneck.

Toward production AI that maintains itself

rightmodeler takes the work out of the loop, not the judgment. It validates cheaper or newer models on your production traces against the outputs you accepted, and opens a draft pull request only when a swap clears every gate. Today, the final yes stays yours.

    ${RUN_COMMAND}

View on GitHub: ${REPO_URL}

${ILLUSTRATIVE_SCORECARD.label}, not measured results

rightmodeler · per-step swap validation

5 steps · quality floor ${ILLUSTRATIVE_SCORECARD.floor}

| status | Step | Family | Current → Candidate | Save | Quality | Evidence | Flag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cleared | 1 | pr_summary | gpt-5.6 → gpt-5.4 | 72% | ${ILLUSTRATIVE_SCORECARD.approved} | reference+judge | · |
| Pending, end-to-end confirmation | 2 | task_planner | claude-opus-5 → llama-3.3-70b | 41% | ${ILLUSTRATIVE_SCORECARD.alternative} | reference+judge | CASCADE · unconfirmed |
| Cleared | 3 | json_extraction | gpt-5.4 → qwen3.7-flash | 68% | ${ILLUSTRATIVE_SCORECARD.deterministic} | deterministic | · |
| Cleared | 4 | sql_generation | gpt-5.4 → deepseek-chat | 55% | ${ILLUSTRATIVE_SCORECARD.alternative} | reference | · |
| Abstained | 5 | auth_code_edit | gpt-5.6 → · | · | · | none | NO EVIDENCE · abstain |

72%

cost reduction · PR summary · illustrative example

## Reads the traces you already have.

Autodetects ${TRACE_SOURCES.length} trace formats into one per-step schema.

Reads traces from ${TRACE_SOURCES.join(", ")}.

Why model swaps stall

## Model maintenance is a standing job.

Every few weeks a new model restarts the manual check. Teams take four shortcuts. None holds up.

### Blind swaps fail quietly.

Nothing throws. The JSON still parses and is wrong on the edge cases.

### Routers don't work in production.

Our view: unvalidated on your workload, an extra hop, harder to reproduce.

### General benchmarks aren't your workload.

A leaderboard ranks models on someone else's tasks, not your accepted outputs.

### Frontier everywhere costs too much.

It feels safe until the bill compounds on steps nobody has measured.

What holds up: one pinned model per step, validated on your own traces.

A swap is safe when it clears every release gate on your own traces.

How the gates work: /how-it-works

View on GitHub: ${REPO_URL}

From validation to autonomy

## It starts with safe model swaps.

### rightmodeler CLI

On npm now

The validation framework. Replay cheaper or newer models on your traces; open a draft PR when a swap clears every gate.

See how it works: /how-it-works

### rightmodeler agent

Self-host today

The maintenance loop. Weekly it flags cheaper models; on your word it replays one and drafts a PR if it clears. It never merges.

Meet the agent: /agent

### Crucible

Open source

Observability for AI agents and MCP servers. Open source and self-hosted, built in Rust for speed and throughput.

Meet Crucible: /crucible

## What teams say about rightmodeler.

${testimonials}

## Start with the traces you already have.

    ${RUN_COMMAND}

View on GitHub: ${REPO_URL}
`;
