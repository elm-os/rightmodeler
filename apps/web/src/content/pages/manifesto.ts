// Markdown twin of the /manifesto route (src/app/manifesto/page.tsx). Keep the two in sync.

import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { REPO_URL, SITE_URL } from "@/lib/site";

export const markdown = `# Measure it. Don't guess.

Manifesto

A model downgrade is a real decision. It deserves evidence, not a vibe.

## The default is over-provisioned.

The biggest model on every step feels safe. Then the bill compounds, call by call, and nobody can say which step earned it.

The claim carries an illustrative figure: a model usage ledger headed "model usage · June" and stamped illustrative, with every step running on the same frontier model.

| Step | Model | Cost |
| --- | --- | --- |
| route | gpt-5.6 | $1,180 |
| extract | gpt-5.6 | $940 |
| summarize | gpt-5.6 | $2,310 |
| judge | gpt-5.6 | $860 |
| rerank | gpt-5.6 | $1,040 |
| embed | gpt-5.6 | $620 |

month to date: $5,290 and climbing

## Evidence beats vibes.

Leaderboards are not your workload. Every candidate is replayed on your own traces and judged against what you shipped.

The claim carries a figure of the audit's decision tree: a trace comes in, the candidates replay, and the two verdicts land on opposite branches.

    new trace
      |
      v
    replay the candidates
      |
      +--> clears the floor --> ✓ swap: gpt-5.4-mini
      |
      +--> below the floor --> ✕ abstain · keep gpt-5.6

## A category, not a feature.

Evidence-backed model downgrading: detect, measure, review. A report you run today, pull requests next, continuous with Crucible.

The claim carries an illustrative figure: a review panel headed "Review the evidence" and stamped ${ILLUSTRATIVE_SCORECARD.label}. The agent's finding reads:

    rightmodeler-agent
    swap: summarize step to gpt-5.4-mini
    Q ${ILLUSTRATIVE_SCORECARD.approved} · 85% cheaper · 214 traces replayed

Under the finding: "Replays, scores, and confidence attached. The merge stays yours." The panel offers two controls, Close and Merge.

## It can say no.

Weak evidence means abstain.

## Your traces are the benchmark.

Judged against what you shipped, never a leaderboard.

## Nothing swaps on its own.

Risks flagged, evidence attached, merge yours.

View on GitHub: ${REPO_URL}

See how it works: ${SITE_URL}/how-it-works

## FAQ

### What is evidence-backed model downgrading?

Reviewing a cheaper candidate only after measuring its output against the output you accepted for the same input. The decision is backed by replays, reference-agreement scores, sample size, and confidence, not a benchmark or a hunch.

### How is this different from observability?

Observability shows you what happened. It doesn't replay your steps through cheaper models, measure agreement with accepted outputs, or prepare a repo edit. rightmodeler reports the evidence and applies only the changes you approve.

### Is it safe to downgrade automatically?

rightmodeler never swaps on its own. It abstains when the evidence is weak, flags cascade risk, and leaves the final call, and the repo edit, to you.
`;
