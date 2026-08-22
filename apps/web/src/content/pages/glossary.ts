// Markdown twin of the /glossary route (src/app/glossary/page.tsx). Keep in sync with the TERMS
// and THEMES constants there: every term, every definition, and every theme intro.

import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";

export const markdown = `# The model-downgrade glossary

Plain definitions for the words rightmodeler uses.

## The decision

The words for reviewing a candidate swap.

### Evidence-backed model downgrading

Reviewing a step for a cheaper model after measuring candidate output against the output you accepted for the same input. The decision rests on reference agreement, evidence, and sample size, not a benchmark or a hunch.

### Model downgrade audit

A pass over your traces that measures each cheaper candidate against the accepted output for the same input, reports the evidence and sample size, and records where it abstains.

### Swap candidate

A cheaper model whose output agrees closely enough with the accepted reference to merit review. This is evidence of agreement with shipped output, not proof of correctness.

Shown alongside these terms, an illustrative panel: the decision as it lands in a repo, with the frontier model commented out, the recommended swap in its place, and the receipts in the trailing comments.

    // steps/summarize.ts · ${ILLUSTRATIVE_SCORECARD.label}

    export const summarize = step({
      // model: "gpt-5.6",  · replaced
      model: "gpt-5.4-mini",  // 85% cheaper
      floor: ${ILLUSTRATIVE_SCORECARD.floor},  // Q ${ILLUSTRATIVE_SCORECARD.approved} clears it
    });

## The guardrails

Where the audit stops.

### Quality floor

The minimum reference-agreement score a candidate must clear to be recommended; below it, the current model stays. rightmodeler's default is ${ILLUSTRATIVE_SCORECARD.floor}, and it's configurable.

### Cascade risk

The chance that downgrading one step degrades later steps that depend on it, common in tool and loop steps. It's flagged so a local win doesn't cause a downstream regression.

### Abstain

The audit's decision to make no recommendation when the evidence or sample is too weak to support one. A tool that always finds savings isn't measuring anything.

Shown alongside these terms, an illustration headed "${ILLUSTRATIVE_SCORECARD.label} scores": candidate models measured against the floor, where only the front one clears it.

- llama-4-nano · ${ILLUSTRATIVE_SCORECARD.lower}
- gpt-5.4-nano · ${ILLUSTRATIVE_SCORECARD.middle}
- gpt-5.4-mini · ${ILLUSTRATIVE_SCORECARD.approved} · clears the floor

## The evidence

What gets measured, and by whom.

### Trace

The recorded steps of an agent run: the models called, their inputs, and their outputs. rightmodeler ingests traces you already emit and folds them into one per-step schema.

### Reference evidence

Grading a cheaper model's output against the output you already accepted for the same input, rather than against a gold answer. The production result is the reference, not ground truth.

### LLM-as-judge

Using a separate model, from a different family than either compared model, to score agreement between two outputs, so nothing grades its own work.

Shown alongside these terms, an illustrative panel: the evidence as configuration, showing what gets measured, against what, and by whom.

    // rightmodeler.config.ts

    export default audit({
      traces: "./traces/*.jsonl",  // 214 runs
      reference: "shipped",  // as shipped
      judge: "cross-family",  // no self-grade
      abstain: "weak-evidence",  // say no
    });
`;
