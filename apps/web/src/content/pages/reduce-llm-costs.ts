// Markdown twin of /use-cases/reduce-llm-costs (src/app/use-cases/reduce-llm-costs/page.tsx).
// Keep this file in sync with that page whenever its copy, mockups, or FAQ change.

import { ILLUSTRATIVE_SCORECARD, TRACE_SOURCES } from "@/lib/product-facts";
import { REPO_URL } from "@/lib/site";

export const markdown = `# Cut your agent's model bill without guessing.

Use case · Reduce LLM costs

Measure cheaper candidates against outputs you accepted, then review the evidence, sample size, and abstentions before you change a model.

## Before rightmodeler

- Every step runs the frontier model, because nobody has measured a cheaper candidate on accepted outputs.
- Swaps happen on vibes: a leaderboard, a launch thread, a hunch. Regressions ship silently.
- The invoice is one number. Which step spent it, nobody can say.
- Evaluating one candidate properly is a two-day project, so it stays unscheduled.
- The expensive default survives another quarter, and the bill scales with your growth.

## With rightmodeler

- Every step is audited on your own traces, with candidate agreement measured per step.
- Candidates are judged against the output you accepted, with a reference-agreement floor.
- The report has line items: save, quality, evidence, and confidence for every call.
- One command on the traces you already have. No new SDK, nothing in your request path.
- Weak evidence means abstain: the frontier model stays exactly where it earns its price.

## Run the audit today

One command runs the audit, nothing to install. The report runs on the traces you already have and hands you recommendations with their evidence.

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

## Then make it continuous

The agent will open evidence-backed model-change pull requests, and Crucible keeps every layer watched. Both are on the way.

- [Meet the agent](/agent)
- [Meet Crucible](/crucible)

The audit as configuration, as shown on the card:

    // rightmodeler.config.ts

    export default audit({
      traces: "./traces/*.jsonl",
      reference: "shipped",
      floor: ${ILLUSTRATIVE_SCORECARD.floor},
      judge: "cross-family",
    });

## Frequently asked questions

### Will cutting cost hurt quality?

The audit does not establish ground-truth quality. It measures each candidate against the output you accepted, reports the evidence and sample size, and abstains when they are weak. You review that evidence before changing a model.

### How much can I save?

It depends on your traces: which steps are over-provisioned, and how cheap a model still clears your quality floor. rightmodeler measures it on your own runs rather than quoting a benchmark; the figures on this page are an illustrative example, not measured results.

### Do I have to switch models everywhere?

No. The audit is per step, not all-or-nothing. Approve one recommendation and leave the rest on the current model.

### Do I need new instrumentation?

No. rightmodeler reads the traces you already emit across ${TRACE_SOURCES.length} formats, folds them into one per-step schema, and runs offline. Nothing sits in your request path.
`;
