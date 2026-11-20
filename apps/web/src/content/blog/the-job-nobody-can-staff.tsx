import {
  A,
  H2,
  Lead,
  P,
  Prose,
  PullQuote,
  Strong,
} from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "the-job-nobody-can-staff",
  title: "The job nobody can staff.",
  description:
    "We think the human work in the loop is the bottleneck in maintaining software. Part three of the rightmodeler vision: why we start by validating cheaper or newer model swaps.",
  excerpt:
    "Every few weeks a model ships, and someone has to notice it, replay it, grade it, and migrate it by hand. Part three of our vision: why that work belongs to software, what safe has to mean, and why the final yes stays with a person today.",
  kicker: "The vision · Part three",
  date: "2026-11-16",
  readingMinutes: 7,
  hero: {
    src: "/blog/the-job-nobody-can-staff-hero.jpg",
    alt: "A warm parchment field where an almost-closed watercolor ring, grey where it begins, finishes in rightmodeler's violet and orange brand accents.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        <A href="/blog/the-tuesday-problem">Part two</A> of this vision turned
        on one line: evaluating one model once is a project, and evaluating
        every model forever is a job. This post is about that job, and why we
        think software should do it.
      </Lead>

      <P>
        The job looks the same every time. A model ships. Someone notices it,
        usually late. Someone pulls real traces, builds a replay, grades the
        outputs against what the team already accepted, writes it up so the swap
        survives review, and migrates. Then the next model ships, and it starts
        again.
      </P>

      <PullQuote>
        With the evidence in hand, the call takes minutes. Producing the
        evidence takes days, and the job comes back every few weeks.
      </PullQuote>

      <P>
        Nobody is hired to do that. It lands on whoever owns the model configs,
        between everything else they were hired for, so most of the time it does
        not get done. That is the job nobody can staff.
      </P>

      <H2>The bottleneck is the work, not the judgment</H2>

      <P>
        Here is the claim behind rightmodeler. We think the biggest bottleneck
        in maintaining software is the human in the loop: not the judgment, the
        work. The usual view treats the person in the loop as the safety, and we
        agree that the judgment is. What stalls is the work around it.
      </P>

      <P>
        We are solving it first for production AI systems, where a new model
        ships every few weeks and each one restarts the same manual job. That
        job has clear inputs, checkable evidence, and a crisp definition of
        done: exactly the kind of work software should take on.
      </P>

      <H2>The shortcuts don&rsquo;t hold up</H2>

      <P>
        Few teams can staff that job, so model decisions get made one of four
        ways. In our view, none of them holds up.
      </P>

      <P>
        <Strong>Blind swaps fail quietly.</Strong> A cheaper model drops into a
        step in thirty seconds. When it fails, nothing throws: the JSON still
        parses and is wrong on the edge cases. A user finds out first.
      </P>

      <P>
        <Strong>Routers don&rsquo;t work in production.</Strong> This is our
        opinion, for three reasons. A runtime router picks a model per request
        with a policy that was not validated on your workload. It adds a hop and
        a dependency to the request path. And the same input can take different
        models, so behavior is harder to reproduce, audit, and roll back. A
        gateway that serves the model you pin is a different thing.
      </P>

      <P>
        <Strong>General benchmarks aren&rsquo;t your workload.</Strong> A
        leaderboard ranks models on someone else&rsquo;s tasks. It cannot tell
        you whether a cheaper model matches the outputs you already accepted, on
        your own prompts.
      </P>

      <P>
        <Strong>Frontier everywhere costs too much.</Strong> The most expensive
        model on every step feels safe until the bill compounds, call by call,
        on steps nobody has measured.
      </P>

      <P>
        What holds up is less exciting: one pinned model per step, validated on
        your own traces and changed through code review. The{" "}
        <A href="/manifesto">manifesto</A> makes the full argument.
      </P>

      <H2>What safe has to mean</H2>

      <P>
        Review needs evidence, and the word safe needs a definition, not a
        feeling. Ours is narrow on purpose.
      </P>

      <P>
        A swap is safe, in rightmodeler&rsquo;s terms, when it clears every
        release gate on your own traces: agreement with the outputs you
        accepted, at a statistical lower bound that reaches your quality floor
        on held-out cases, with swaps that feed later model steps confirmed end
        to end in a sandbox. rightmodeler measures agreement with what you
        shipped, not ground-truth correctness, and abstains when the evidence is
        thin.
      </P>

      <P>
        Two parts of that sentence carry the weight. The first is abstention.
        Thin evidence means no swap, and the report names the reason instead of
        guessing. A tool that finds a swap every time is not measuring anything.
      </P>

      <P>
        The second is what it does not claim. Agreement with what you shipped is
        not correctness. The built-in judge can tell you that a cheaper or newer
        model matches what you accepted, never that either one is right: if an
        accepted output was wrong, a candidate that reproduces it passes.
      </P>

      <H2>Where it starts</H2>

      <P>
        Validation comes first because everything after it depends on it. A
        system that changes models without a check that can say no is a blind
        swap on a schedule.
      </P>

      <P>
        The <A href="/how-it-works">rightmodeler CLI</A> is that check: a
        validation framework for model swaps, MIT-licensed and on npm. It reads
        the model calls your app already recorded and replays the recorded
        steps, offline, on cheaper candidate models from your provider&rsquo;s
        live catalog: by default up to three released in the last 90 days, or
        models you name with --candidate that cost less. Upgrades, same-price
        successors and moves off retired models are not validated today. A judge
        from a different vendor, or your own evaluator, grades every answer
        against the output you accepted. Replay sends recorded text
        conversations: cases whose conversation carries tool calls, tool
        definitions or non-text parts are left out of the replay sample today,
        and the run says how many.
      </P>

      <P>
        A swap that clears every gate becomes a draft pull request that changes
        only model identifiers, with the evidence attached. The watch command
        follows that pull request through review and CI, and the rollback
        command opens a pull request that restores the exact pre-swap files. A
        coding-agent skill drives the same CLI.
      </P>

      <P>
        <A href="/agent">rightmodeler agent</A> is the maintenance loop, on a
        schedule. It lives in the same repository, and you can self-host it
        today; the hosted version has a waitlist. It runs a weekly catalog and
        price check that flags cheaper new or repriced models, a daily drift
        check on new traces whose proposals a person approves, and one
        regression replay for each merged swap set, and it follows up on swap
        pull requests as review and CI report back. On your word it replays new
        candidates, and once a replay clears every gate, it opens the draft pull
        request. It never merges and carries no merge capability.
      </P>

      <P>
        The CLI and the agent run offline, beside your app, on your machine or
        in CI. Nothing sits in the request path, there is no rightmodeler
        server, and there is no telemetry.
      </P>

      <P>
        Crucible lives in its own MIT-licensed repository: self-hosted
        observability and analytics for AI agents and MCP servers, one Rust
        binary that ingests OpenTelemetry. rightmodeler replays Crucible traces
        to validate cheaper or newer models.
      </P>

      <H2>Why the final yes stays with a person today</H2>

      <P>
        Today a person sets the policy: the quality floor, which models are
        allowed, and an optional spend cap. A person gives the agent the word
        before it replays a new candidate, and only a person merges a draft pull
        request. Rolling back is one command that opens another pull request.
      </P>

      <P>
        Some of the agent&rsquo;s work runs without a fresh word, and we would
        rather name it than round it off: it rechecks the catalog, flags drift
        for a person to approve, gives each merged swap set one regression
        replay, and follows up on swap pull requests, which can mean closing one
        whose CI failure repeats. None of that merges anything.
      </P>

      <P>
        Keeping the final yes with a person is deliberate. We are not asking
        anyone to trust a system that changes models on its own. We are building
        the evidence that would justify one. Autonomy is earned with evidence,
        and validation is how rightmodeler earns it. rightmodeler takes the work
        out of the loop, not the judgment. Today, the final yes stays yours.
      </P>

      <H2>Where it goes</H2>

      <P>
        We think software should maintain itself, and we are working toward
        production AI that maintains and optimizes itself inside the policy you
        set, reached one validated change at a time. The self-hosted agent
        already runs part of that loop on a schedule, and Crucible shows what
        your agents and MCP servers do, because you cannot maintain what you
        cannot see.
      </P>

      <P>
        That is a direction, not a dated roadmap. Each step past today has to be
        earned the way a swap is earned now: with evidence a person can check,
        inside the policy that person set.
      </P>

      <P>
        If the job at the top of this post sounds familiar, start with the
        traces you already have. Run npx rightmodeler init from your repository
        and read what comes back. The <A href="/manifesto">manifesto</A> is the
        thesis on one page, <A href="/agent">the agent page</A> covers the
        maintenance loop, and{" "}
        <A href="/blog/the-bill-nobody-can-read">part one</A> and{" "}
        <A href="/blog/the-tuesday-problem">part two</A> of the vision cover the
        bill nobody can read and the Tuesday a new model lands.
      </P>
    </Prose>
  );
}

// Kept in sync with Body above by hand.
export const markdown = `# The job nobody can staff.

[Part two](https://www.rightmodeler.com/blog/the-tuesday-problem) of this vision turned on one line: evaluating one model once is a project, and evaluating every model forever is a job. This post is about that job, and why we think software should do it.

The job looks the same every time. A model ships. Someone notices it, usually late. Someone pulls real traces, builds a replay, grades the outputs against what the team already accepted, writes it up so the swap survives review, and migrates. Then the next model ships, and it starts again.

> With the evidence in hand, the call takes minutes. Producing the evidence takes days, and the job comes back every few weeks.

Nobody is hired to do that. It lands on whoever owns the model configs, between everything else they were hired for, so most of the time it does not get done. That is the job nobody can staff.

## The bottleneck is the work, not the judgment

Here is the claim behind rightmodeler. We think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work. The usual view treats the person in the loop as the safety, and we agree that the judgment is. What stalls is the work around it.

We are solving it first for production AI systems, where a new model ships every few weeks and each one restarts the same manual job. That job has clear inputs, checkable evidence, and a crisp definition of done: exactly the kind of work software should take on.

## The shortcuts don't hold up

Few teams can staff that job, so model decisions get made one of four ways. In our view, none of them holds up.

**Blind swaps fail quietly.** A cheaper model drops into a step in thirty seconds. When it fails, nothing throws: the JSON still parses and is wrong on the edge cases. A user finds out first.

**Routers don't work in production.** This is our opinion, for three reasons. A runtime router picks a model per request with a policy that was not validated on your workload. It adds a hop and a dependency to the request path. And the same input can take different models, so behavior is harder to reproduce, audit, and roll back. A gateway that serves the model you pin is a different thing.

**General benchmarks aren't your workload.** A leaderboard ranks models on someone else's tasks. It cannot tell you whether a cheaper model matches the outputs you already accepted, on your own prompts.

**Frontier everywhere costs too much.** The most expensive model on every step feels safe until the bill compounds, call by call, on steps nobody has measured.

What holds up is less exciting: one pinned model per step, validated on your own traces and changed through code review. The [manifesto](https://www.rightmodeler.com/manifesto) makes the full argument.

## What safe has to mean

Review needs evidence, and the word safe needs a definition, not a feeling. Ours is narrow on purpose.

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

Two parts of that sentence carry the weight. The first is abstention. Thin evidence means no swap, and the report names the reason instead of guessing. A tool that finds a swap every time is not measuring anything.

The second is what it does not claim. Agreement with what you shipped is not correctness. The built-in judge can tell you that a cheaper or newer model matches what you accepted, never that either one is right: if an accepted output was wrong, a candidate that reproduces it passes.

## Where it starts

Validation comes first because everything after it depends on it. A system that changes models without a check that can say no is a blind swap on a schedule.

The [rightmodeler CLI](https://www.rightmodeler.com/how-it-works) is that check: a validation framework for model swaps, MIT-licensed and on npm. It reads the model calls your app already recorded and replays the recorded steps, offline, on cheaper candidate models from your provider's live catalog: by default up to three released in the last 90 days, or models you name with --candidate that cost less. Upgrades, same-price successors and moves off retired models are not validated today. A judge from a different vendor, or your own evaluator, grades every answer against the output you accepted. Replay sends recorded text conversations: cases whose conversation carries tool calls, tool definitions or non-text parts are left out of the replay sample today, and the run says how many.

A swap that clears every gate becomes a draft pull request that changes only model identifiers, with the evidence attached. The watch command follows that pull request through review and CI, and the rollback command opens a pull request that restores the exact pre-swap files. A coding-agent skill drives the same CLI.

[rightmodeler agent](https://www.rightmodeler.com/agent) is the maintenance loop, on a schedule. It lives in the same repository, and you can self-host it today; the hosted version has a waitlist. It runs a weekly catalog and price check that flags cheaper new or repriced models, a daily drift check on new traces whose proposals a person approves, and one regression replay for each merged swap set, and it follows up on swap pull requests as review and CI report back. On your word it replays new candidates, and once a replay clears every gate, it opens the draft pull request. It never merges and carries no merge capability.

The CLI and the agent run offline, beside your app, on your machine or in CI. Nothing sits in the request path, there is no rightmodeler server, and there is no telemetry.

Crucible lives in its own MIT-licensed repository: self-hosted observability and analytics for AI agents and MCP servers, one Rust binary that ingests OpenTelemetry. rightmodeler replays Crucible traces to validate cheaper or newer models.

## Why the final yes stays with a person today

Today a person sets the policy: the quality floor, which models are allowed, and an optional spend cap. A person gives the agent the word before it replays a new candidate, and only a person merges a draft pull request. Rolling back is one command that opens another pull request.

Some of the agent's work runs without a fresh word, and we would rather name it than round it off: it rechecks the catalog, flags drift for a person to approve, gives each merged swap set one regression replay, and follows up on swap pull requests, which can mean closing one whose CI failure repeats. None of that merges anything.

Keeping the final yes with a person is deliberate. We are not asking anyone to trust a system that changes models on its own. We are building the evidence that would justify one. Autonomy is earned with evidence, and validation is how rightmodeler earns it. rightmodeler takes the work out of the loop, not the judgment. Today, the final yes stays yours.

## Where it goes

We think software should maintain itself, and we are working toward production AI that maintains and optimizes itself inside the policy you set, reached one validated change at a time. The self-hosted agent already runs part of that loop on a schedule, and Crucible shows what your agents and MCP servers do, because you cannot maintain what you cannot see.

That is a direction, not a dated roadmap. Each step past today has to be earned the way a swap is earned now: with evidence a person can check, inside the policy that person set.

If the job at the top of this post sounds familiar, start with the traces you already have. Run npx rightmodeler init from your repository and read what comes back. The [manifesto](https://www.rightmodeler.com/manifesto) is the thesis on one page, [the agent page](https://www.rightmodeler.com/agent) covers the maintenance loop, and [part one](https://www.rightmodeler.com/blog/the-bill-nobody-can-read) and [part two](https://www.rightmodeler.com/blog/the-tuesday-problem) of the vision cover the bill nobody can read and the Tuesday a new model lands.
`;
