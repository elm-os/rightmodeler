// Markdown twin of src/app/use-cases/reduce-llm-costs/page.tsx. Keep the two in sync.

import { ILLUSTRATIVE_SCORECARD, TRACE_SOURCES } from "@/lib/product-facts";
import { REPO_URL } from "@/lib/site";

export const markdown = `# Cut your agent's model bill without guessing.

Use case · Reduce LLM costs

Frontier everywhere costs too much: the most expensive model on every step feels safe until the bill compounds, call by call, on steps nobody has measured. rightmodeler validates cheaper or newer models on your production traces and opens a draft pull request only where a swap clears every gate.

## Before rightmodeler

- Every step runs the frontier model, because nobody has measured a cheaper candidate on accepted outputs.
- Swaps happen on vibes: a leaderboard, a launch thread, a hunch. Regressions ship silently.
- The invoice is one number. Which step spent it, nobody can say.
- Evaluating one candidate properly is a two-day project, so it stays unscheduled.
- The expensive default survives another quarter, and the bill scales with your growth.

## With rightmodeler

- Steps are validated on your own traces, with candidate agreement measured per step.
- Only cheaper models are candidates, each judged against the output you accepted and held to your quality floor.
- The report has line items: save, quality, evidence, and sample size for every step.
- One command on the traces you already have. No new SDK, nothing in your request path.
- Thin evidence means abstain: the frontier model stays exactly where it earns its price.

## Run a validation today.

One command, nothing to install, on the traces you already have. Validation is what makes a saving worth taking: rightmodeler abstains where the evidence is thin and opens a draft pull request only for a swap that clears every gate.

View on GitHub: ${REPO_URL}

The per-step report shown on the card, mid-scroll. The figures are stamped illustrative, and the last row abstains:

    rightmodeler · per-step report                ${ILLUSTRATIVE_SCORECARD.label}

    summarize                     save 85% · Q ${ILLUSTRATIVE_SCORECARD.approved}
    gpt-5.6 → gpt-5.4-mini

    extract_json                  save 96% · Q ${ILLUSTRATIVE_SCORECARD.deterministic}
    gpt-5.5 → gpt-5.4-nano

    sql_generation                save 50% · Q ${ILLUSTRATIVE_SCORECARD.alternative}
    gpt-5.6 → gpt-5.4

    auth_code_edit                abstain · thin evidence
    stays on gpt-5.6

## Then put it on a schedule.

Run the same validation weekly in CI with the GitHub Actions recipe in the docs, or self-host the agent: it checks the catalog every week for cheaper new or repriced models, and on your word it replays a new candidate and opens each swap that clears every gate as a draft pull request. The hosted agent has a waitlist. Crucible, in development, is planned as open-source, self-hosted observability for AI agents and MCP servers, including cost and latency.

- [Meet the agent](/agent)
- [Meet Crucible](/crucible)

A release policy as shown on the card, stamped illustrative:

    // policy.json · ${ILLUSTRATIVE_SCORECARD.label}

    {
      "qualityFloor": ${ILLUSTRATIVE_SCORECARD.floor},
      "shortlistTop": 3,
      "denyModels": ["llama-4-nano"]
    }

## Frequently asked questions

### Will cutting cost hurt quality?

rightmodeler does not establish ground-truth quality. A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin. You review that evidence in a draft pull request before any model changes.

### How much can I save?

It depends on your traces: which steps are over-provisioned, and how cheap a model still clears your quality floor. rightmodeler measures it on your own runs rather than quoting a general benchmark; the figures on this page are an illustrative example, not measured results.

### Do I have to switch models everywhere?

No. Validation is per step, not all-or-nothing. Only a step whose cheaper candidate clears every gate gets a draft pull request; every other step stays on its current model.

### Do I need new instrumentation?

Not to validate a step. rightmodeler reads the traces you already emit across ${TRACE_SOURCES.length} formats, folds them into one per-step schema, and runs offline. Nothing sits in your request path. Only end-to-end confirmation, for a step that feeds later model steps, needs your app to tag each model call with its step.
`;
