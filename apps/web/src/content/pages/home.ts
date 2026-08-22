// Markdown twin of the / route (src/app/page.tsx and the hero, sources bar, platform, testimonial
// band, and CTA band sections it composes). Keep the two in sync.
import { ILLUSTRATIVE_SCORECARD, TRACE_SOURCES } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

export const markdown = `# Measure cheaper models against what you shipped.

Evidence-backed model decisions

rightmodeler replays your real agent traces through cheaper models, judges each output against what you already shipped, and reports agreement, cost, evidence, sample size, and every abstention.

72%

cost reduction · PR summary · medium confidence · illustrative example

    ${RUN_COMMAND}

View on GitHub: ${REPO_URL}

${ILLUSTRATIVE_SCORECARD.label}, not measured results

rightmodeler · per-step approval

5 steps · quality floor ${ILLUSTRATIVE_SCORECARD.floor}

| status | Step | Family | Current → Candidate | Save | Quality | Evidence | Flag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Approved | 1 | pr_summary | gpt-5.6 → gpt-5.4 | 72% | ${ILLUSTRATIVE_SCORECARD.approved} | reference+judge | · |
| Pending, cascade risk | 2 | tool_agent | claude-opus-5 → llama-3.3-70b | 41% | ${ILLUSTRATIVE_SCORECARD.pending} | trajectory | CASCADE |
| Approved | 3 | json_extraction | gpt-5.4 → qwen3.7-flash | 68% | ${ILLUSTRATIVE_SCORECARD.deterministic} | deterministic | · |
| Approved | 4 | sql_generation | gpt-5.4 → deepseek-chat | 55% | ${ILLUSTRATIVE_SCORECARD.alternative} | reference | · |
| Abstained | 5 | auth_code_edit | gpt-5.6 → · | · | · | none | NO EVIDENCE · abstain |

Reads the traces you already have.

Autodetects ${TRACE_SOURCES.length} trace formats into one per-step schema.

Reads traces from ${TRACE_SOURCES.join(", ")}.

The platform

## See everything. Measure candidates. Review the pull request.

### rightmodeler CLI

On npm now

The audit. Replay your traces through cheaper models and ship approved swaps as a pull request, evidence attached. Your coding agent can drive it through the skill.

Run the audit: /how-it-works

### rightmodeler agent

Open source now

The autopilot. A new model ships; your repo gets a pull request with the evidence attached. Migrations become code review.

Meet the agent: /agent

### Crucible

Early access

The instruments. Cost per layer, speed per step, failures as they happen, and a stack that stays right-sized.

Meet Crucible: /crucible

> "rightmodeler took AI Assist from brute force to precision routing. Costs fell 70.8%, responses got twice as fast, and quality held at 100%, measured, not assumed."

Chris Myers, CEO, B:Side Capital and Fund

Measured on a 20-query benchmark against the outputs B:Side had accepted.

Read the story: /case-study/bside

> "rightmodeler concentrated intelligence where our members feel it. The hardest coaching moved up to Sol, routine work got faster, and cost per request dropped by more than half."

Brian Douglas, Founder, iAM360

Read the story: /case-study/iam360

## Run it on your own traces.

    ${RUN_COMMAND}

Free until replay, then your own provider key. It’s a report, not a runtime gateway.

View on GitHub: ${REPO_URL}
`;
