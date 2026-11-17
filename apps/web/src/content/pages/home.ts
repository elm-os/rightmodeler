// Markdown twin of the / route (src/app/page.tsx and the hero, sources bar, thesis band, platform,
// numbers band, testimonial band, and CTA band sections it composes). Keep the two in sync.
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

rightmodeler takes the work out of the loop, not the judgment. It validates cheaper models on your production traces against the outputs you accepted, and opens a draft pull request only when a swap clears every gate. Today, the final yes stays yours.

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

For a production AI system, a new model ships every few weeks, and each one has to be noticed, replayed on real traces, graded, written up, and migrated. That work, not the final call, is the bottleneck: the human in the loop spends days on it. Few teams can staff it, so model decisions get made one of four ways. In our view, none of them holds up.

### Blind swaps fail quietly.

A cheaper model drops into a step in thirty seconds. When it fails, nothing throws: the JSON still parses and is wrong on the edge cases. A user finds out first.

### Routers don't work in production.

This is our opinion, for three reasons. A runtime router picks a model per request with a policy that was not validated on your workload. It adds a hop and a dependency to the request path. And the same input can take different models, so behavior is harder to reproduce, audit, and roll back. A gateway that serves the model you pin is a different thing.

### General benchmarks aren't your workload.

A leaderboard ranks models on someone else's tasks. It can't tell you whether a cheaper model matches the outputs you already accepted, on your own prompts.

### Frontier everywhere costs too much.

The most expensive model on every step feels safe. Then the bill compounds, call by call, on steps nobody has measured.

What holds up: one pinned model per step, validated on your own traces and changed through code review.

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin. We are building toward systems that maintain and optimize themselves, starting where the evidence can be checked.

From validation to autonomy

## It starts with safe model swaps.

### rightmodeler CLI

On npm now

The validation framework. Replay cheaper models on your traces; open a draft pull request when a swap clears every gate.

See how it works: /how-it-works

### rightmodeler agent

Self-host today

The maintenance loop. Weekly it flags cheaper models; on your word it replays one and drafts a PR if it clears. It never merges.

Meet the agent: /agent

### Crucible

In development

The instruments, planned. Cost per layer, speed per step, failures as they happen, over MCP, never in the request path.

Meet Crucible: /crucible

The numbers

## Real workloads, not leaderboards.

${TRACE_SOURCES.length} trace formats autodetected into one per-step schema

70.8% projected lower inference cost after right-sizing, B:Side

100% quality held against shipped outputs, measured, B:Side

53.3% projected faster responses on the same workloads, B:Side

## What teams say about rightmodeler.

${testimonials}

## Start with the traces you already have.

    ${RUN_COMMAND}

View on GitHub: ${REPO_URL}
`;
