// Markdown twin of /glossary: keep in sync with TERMS and THEMES in src/app/glossary/page.tsx.

import {
  DEFAULT_QUALITY_FLOOR,
  ILLUSTRATIVE_SCORECARD,
} from "@/lib/product-facts";

export const markdown = `# The model-swap glossary

Glossary

Plain definitions for the words rightmodeler uses to validate a swap to a cheaper or newer model.

## The decision

The words for a swap to a cheaper or newer model.

### Safe model swap

rightmodeler validates only swaps to cheaper or newer models. A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

### Swap candidate

A cheaper model shortlisted for one step, from your provider's live catalog or named with --candidate, and replayed on that step's recorded inputs. It must cost less than the recorded model, even when you name it. Clearing every gate is evidence of agreement with what you shipped, not ground-truth correctness.

### Model downgrade

Another name for a swap to a cheaper model. rightmodeler says swap, because downgrade presumes the quality loss that the release gates test for.

Shown alongside these terms, an illustrative panel: one step annotated with the decision, the frontier model it replaces commented out, the cheaper model in its place, and the receipts in trailing comments.

    // steps/summarize.ts · ${ILLUSTRATIVE_SCORECARD.label}

    export const summarize = step({
      // model: "gpt-5.6",  · replaced
      model: "gpt-5.4-mini",  // 85% cheaper
      floor: ${ILLUSTRATIVE_SCORECARD.floor},  // Q ${ILLUSTRATIVE_SCORECARD.approved} clears it
    });

## The gates

What a swap has to clear.

### Release gate

A check every swap must pass before it becomes a draft pull request: agreement, at a statistical lower bound, that reaches your quality floor on held-out cases, enough answered calls, and end-to-end confirmation for a step that feeds later model steps.

### Quality floor

The agreement a candidate must reach on held-out cases, at a statistical lower bound, to be recommended; below it, the current model stays. The default is ${DEFAULT_QUALITY_FLOOR}, and a policy file can set it above 0.8 and below 1.

### Statistical lower bound

The low end of a 95% interval around a measured agreement rate. rightmodeler compares the bound, not the raw rate, with your floor, so a small sample has to do better to clear it. There are no confidence tiers.

Shown alongside these terms, an illustration headed "${ILLUSTRATIVE_SCORECARD.label} scores": candidate models set against the floor, where only the front one clears it.

- llama-4-nano · ${ILLUSTRATIVE_SCORECARD.lower}
- gpt-5.4-nano · ${ILLUSTRATIVE_SCORECARD.middle}
- gpt-5.4-mini · ${ILLUSTRATIVE_SCORECARD.approved} · clears the floor

## The guardrails

What stops a lucky or local win from becoming a pull request.

### Held-out cases

Recorded cases kept out of the shortlist screen. rightmodeler splits your cases into a shortlist half, which only screens candidates on their pass rate, and a held-out half. Only the cheapest candidate that passes the screen is replayed on the held-out half, where its lower bound has to reach your quality floor, adjusted for how many candidates competed.

### Cascade risk

The chance that swapping one step to a cheaper or newer model degrades later steps that depend on it, common in tool and loop steps. When a step feeds later model steps, its swap counts only once it is confirmed end to end, judged on your app's final output rather than on the step alone.

### End-to-end confirmation

Running your own app on recorded cases in a sandbox, apart from production, with the cheaper candidate in place on the swapped steps, then judging the app's final output against the recorded one. A swap whose step feeds later model steps needs it: without it, the swap is reported as unconfirmed and no pull request opens. If the run traces a failure to the swap, the swap is rejected; if it cannot tell, rightmodeler abstains. The CLI docs and the --modeb-config flag call this Mode B, and it needs step headers in your app. The sandbox keeps your model key out but has ordinary network access, so point your app's tools at test fixtures, not production services.

### Abstain

rightmodeler's decision to make no recommendation when the evidence or sample is too thin to support one, with a named reason, such as too few review trials. The current model stays. A tool that always finds savings isn't measuring anything.

## The evidence

What gets measured, and by whom.

### Trace

The recorded steps of an agent run: the models called, their inputs, and their outputs. rightmodeler ingests traces you already emit and folds them into one per-step schema.

### Production traces

The model calls your production app already recorded, through a tracing platform, OpenTelemetry, or gateway logs. rightmodeler validates on them offline and never on live traffic. Claude Code sessions on disk work too; Codex sessions are read, but only a Codex turn that called no tools can enter the replay sample today. Both are traces you already have, not production traces.

### Reference evidence

Grading a cheaper or newer model's output against the output you already accepted for the same input, rather than against a gold answer. The production result is the reference, not ground truth, so a candidate that repeats a wrong accepted answer still agrees.

### LLM-as-judge

Using a separate model, from a different family than either compared model, to score agreement between two outputs, so nothing grades its own work. rightmodeler's judge reads both answer orders and passes a case only when both agree, and your own evaluator can grade instead.

Shown alongside these terms, an illustrative panel summarizing what gets measured, against what, and by whom.

    // the evidence · ${ILLUSTRATIVE_SCORECARD.label}

    traces     214 recorded runs
    reference  the outputs you accepted
    judge      a different vendor
               or your own evaluator
    if thin    abstain

## The loop

The work in the loop, who does it, and where it runs.

### Human in the loop

In machine learning the phrase often means people labeling data or reviewing outputs. In rightmodeler's usage it is the hand work that comes back each time a model ships: noticing it, pulling real traces, building a replay, grading the outputs, writing it up so it survives review, and migrating. rightmodeler takes the work out of the loop, not the judgment; today, the final yes stays yours.

### Swap validation

Testing a swap to a cheaper or newer model on your own traces before anyone merges it. rightmodeler replays the recorded steps on cheaper or newer candidate models, has a judge from a different vendor, or your own evaluator, grade every answer against the output you accepted, and opens a draft pull request only for a swap that clears every release gate.

### Validation run

One pass of rightmodeler over your traces: it measures each cheaper or newer candidate against the accepted output for the same input, reports the evidence and sample size, and records where it abstains.

### Runtime router

A service in the request path that picks a model for each request at runtime. rightmodeler is not one: it validates one pinned model per step, offline, before a person merges the change. A gateway that serves the model you pin is a different thing, and rightmodeler can replay through one.
`;
