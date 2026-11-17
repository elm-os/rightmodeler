import { A, H2, Lead, P, Prose, PullQuote } from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "why-we-built-rightmodeler",
  title: "We were picking models by vibes. Then the bill arrived.",
  description:
    "We picked models by vibes and paid the frontier bill. The bottleneck was checking each model by hand, so we built rightmodeler to validate cheaper model swaps.",
  excerpt:
    "We shipped agentic systems for years while guessing which model belonged at which step. The bottleneck was the work of checking each cheaper model by hand. rightmodeler is that check, made properly.",
  kicker: "Founding story",
  date: "2026-07-05",
  readingMinutes: 7,
  hero: {
    src: "/blog/why-we-built-rightmodeler-hero.jpg",
    alt: "A warm parchment field with a low, grain-textured gradient horizon in rightmodeler's violet and orange brand accents.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        For most of our careers, we picked the model behind every agent the same
        way. We guessed. That is an awkward thing to admit, because we build
        agentic systems for a living, and across all of that work there was
        never a well known, rigorous way to decide which model belongs at which
        step in the stack.
      </Lead>

      <P>
        So we did what nearly everyone does. We went with instinct, or with
        whatever had been praised on the timeline that week, or we reached for
        the newest and most capable frontier model because it was the safe
        choice. Nobody gets a hard time for putting the best model on the job.
        If you have shipped an agent, you already know this feeling. You wired
        up a graph of steps, you needed something that worked, and “use the
        strong model everywhere” was the answer that let you move on to the next
        problem.
      </P>

      <P>
        Guessing is a strange thing for engineers to admit to. We measure
        everything else. We had latency budgets, eval suites, retry logic, and
        dashboards for all of it. The model assignment, the single biggest lever
        on both quality and cost, was vibes.
      </P>

      <H2>The safe choice has a bill</H2>

      <P>
        Defaulting to the strongest model is defensible right up until the
        invoice arrives, and the invoice never arrives as one event. It accrues.
        Every call, every step in the graph, every retry, every user, every day.
        A multi-agent system might touch a frontier model several times to
        answer one question, and most of those touches are bookkeeping. Routing.
        Extraction. Reformatting one agent’s output so the next one can read it.
      </P>

      <P>
        For an internal tool you might never notice. For a consumer-facing app
        at real volume it is brutal, and it gets worse on exactly the trajectory
        you want, which is up and to the right. The reward for growth is a
        larger bill for work a cheaper model could have done.
      </P>

      <P>
        We felt this most sharply while building the agentic systems for{" "}
        <A href="https://bsideassist.com">bsideassist.com</A> at B:Side Capital
        and Fund. It is a real product with real users, and it made the problem
        concrete. New models kept shipping every few weeks, each with its own
        benchmarks and its own promises, and every release forced the same
        question we could not answer with confidence: are we paying for
        capability this task does not actually use? We had the same experience
        elsewhere, at a consumer app running at volume and at a fintech team
        that could not afford a quality regression, where the strong model was
        carrying steps that did not need it and we had no clean way to measure
        candidate agreement on our own workload.
      </P>

      <H2>Not every step is a hard problem</H2>

      <P>
        Here is the structural opportunity. Many multi-agent architectures
        contain narrow, well-specified steps: extracting fields from a document,
        routing a request to the right branch, or summarizing context for the
        next step. Cheaper models are often reasonable candidates for work like
        this. That is a hypothesis to test per workload, not a result to assume.
        A frontier model should earn its price on genuinely hard reasoning, not
        inherit every step by default.
      </P>

      <PullQuote>
        The expensive model should earn its price on the hard reasoning, not on
        every step that happens to sit next to it.
      </PullQuote>

      <P>
        The intuition is easy. Measuring it for your system is the actual work.
        A blind swap is easy and worthless. You can drop a cheaper candidate
        into a step in thirty seconds. What you cannot do in thirty seconds is
        know whether it quietly got worse. Cheaper models fail in ways that do
        not throw errors. The extraction still returns valid JSON, it is just
        wrong on the edge cases. The summary still reads fine, it just dropped
        the one detail that mattered downstream. You do not find out from a
        stack trace. You find out from a user, later, when it is expensive.
      </P>

      <H2>We had built this before, more than once</H2>

      <P>
        So more than once, internally and on client work, we hand-built a
        version of the check. We took the traces we had already run through the
        strong model, replayed them through a cheaper one, and compared the two
        outputs step by step to see where the cheap model held and where it
        broke. It was never a product. It was a folder of scripts and a
        spreadsheet, stood up under deadline because we needed the answer and no
        one was going to hand it to us. And every time we bothered, it paid for
        itself, usually by showing that a cheaper candidate matched our accepted
        output closely enough to merit a review of the swap.
      </P>

      <H2>Everyone had the same problem</H2>

      <P>
        We assumed this was a quirk of how we worked. It was not. As we talked
        to other people building these systems, across teams and companies, we
        kept hearing the identical description of the identical problem.
        Everyone had defaulted to the frontier model. Everyone suspected they
        were overpaying. Almost nobody had a rigorous way to measure cheaper
        candidates against outputs they had accepted, so almost nobody changed
        anything, because the downside of a silent quality regression was
        scarier than the bill. At some point the pattern was obvious enough that
        guessing looked less like a habit and more like a liability. So we
        decided to build it properly, as a product, instead of rebuilding it by
        hand for the fourth time.
      </P>

      <H2>A pull request, not a gateway</H2>

      <P>
        rightmodeler is that check, built properly: a validation framework for
        model swaps. It reads the model calls your app already recorded and
        replays the recorded steps on cheaper candidate models from your
        provider’s live catalog. A judge from a different vendor, or your own
        evaluator, grades every answer against the output you accepted, the one
        you have already decided is good enough. It runs on your own traces, not
        synthetic prompts, so the results reflect your actual workload and not a
        general benchmark.
      </P>

      <P>
        A swap that clears every release gate becomes a draft pull request that
        changes only model identifiers, with the evidence attached. Everything
        runs offline, beside your app, on your machine or in CI. Nothing sits in
        your request path, routes your traffic, or adds a hop to a request. You
        read the evidence, and you decide whether the change merges.
      </P>

      <P>
        The part we are most attached to is that it can say no. When the cheaper
        model’s outputs do not hold up, or the sample is too thin to be sure, it
        declines to recommend the swap and tells you so. A tool that always
        finds savings is not measuring anything. The value is a report you can
        inspect in both directions, including the boring, expensive result where
        there is not enough evidence to recommend a change.
      </P>

      <H2>The bottleneck was the work</H2>

      <P>
        We spent years picking models by feel and calling it judgment. It was
        not judgment. It was a guess we had stopped noticing. The fix was never
        a better instinct. It was evidence drawn from traces we had already run,
        showing which candidates matched accepted outputs closely enough to
        review.
      </P>

      <P>
        Looking back, the guessing was a symptom. The bottleneck was always the
        human work in the loop, the work of evaluating every model change by
        hand: noticing the release, pulling real traces, building a replay,
        grading the outputs, writing it up so it survived review, migrating, and
        doing it all again when the next model shipped. With the evidence in
        front of us, the call took minutes. Producing the evidence took days,
        every time, so most of the time nobody produced it, and a guess filled
        the gap. rightmodeler takes that work out of the loop, not the judgment,
        starting with swaps to cheaper models. Today, the final yes stays yours.
      </P>

      <P>
        We think software should maintain itself, and that autonomy is earned
        with evidence. Validation on your own traces is how rightmodeler earns
        it: the first step toward a system that maintains itself inside the
        policy you set, reached one validated change at a time.
      </P>

      <P>
        Part three of our vision,{" "}
        <A href="/blog/the-job-nobody-can-staff">The job nobody can staff</A>,
        makes the case that the work in the loop belongs to software.
      </P>

      <P>
        The honest next step is the same one we always took. Point it at your
        own traces and read what comes back.
      </P>
    </Prose>
  );
}

// Kept in sync with Body above by hand.
export const markdown = `# We were picking models by vibes. Then the bill arrived.

For most of our careers, we picked the model behind every agent the same way. We guessed. That is an awkward thing to admit, because we build agentic systems for a living, and across all of that work there was never a well known, rigorous way to decide which model belongs at which step in the stack.

So we did what nearly everyone does. We went with instinct, or with whatever had been praised on the timeline that week, or we reached for the newest and most capable frontier model because it was the safe choice. Nobody gets a hard time for putting the best model on the job. If you have shipped an agent, you already know this feeling. You wired up a graph of steps, you needed something that worked, and "use the strong model everywhere" was the answer that let you move on to the next problem.

Guessing is a strange thing for engineers to admit to. We measure everything else. We had latency budgets, eval suites, retry logic, and dashboards for all of it. The model assignment, the single biggest lever on both quality and cost, was vibes.

## The safe choice has a bill

Defaulting to the strongest model is defensible right up until the invoice arrives, and the invoice never arrives as one event. It accrues. Every call, every step in the graph, every retry, every user, every day. A multi-agent system might touch a frontier model several times to answer one question, and most of those touches are bookkeeping. Routing. Extraction. Reformatting one agent's output so the next one can read it.

For an internal tool you might never notice. For a consumer-facing app at real volume it is brutal, and it gets worse on exactly the trajectory you want, which is up and to the right. The reward for growth is a larger bill for work a cheaper model could have done.

We felt this most sharply while building the agentic systems for [bsideassist.com](https://bsideassist.com) at B:Side Capital and Fund. It is a real product with real users, and it made the problem concrete. New models kept shipping every few weeks, each with its own benchmarks and its own promises, and every release forced the same question we could not answer with confidence: are we paying for capability this task does not actually use? We had the same experience elsewhere, at a consumer app running at volume and at a fintech team that could not afford a quality regression, where the strong model was carrying steps that did not need it and we had no clean way to measure candidate agreement on our own workload.

## Not every step is a hard problem

Here is the structural opportunity. Many multi-agent architectures contain narrow, well-specified steps: extracting fields from a document, routing a request to the right branch, or summarizing context for the next step. Cheaper models are often reasonable candidates for work like this. That is a hypothesis to test per workload, not a result to assume. A frontier model should earn its price on genuinely hard reasoning, not inherit every step by default.

> The expensive model should earn its price on the hard reasoning, not on every step that happens to sit next to it.

The intuition is easy. Measuring it for your system is the actual work. A blind swap is easy and worthless. You can drop a cheaper candidate into a step in thirty seconds. What you cannot do in thirty seconds is know whether it quietly got worse. Cheaper models fail in ways that do not throw errors. The extraction still returns valid JSON, it is just wrong on the edge cases. The summary still reads fine, it just dropped the one detail that mattered downstream. You do not find out from a stack trace. You find out from a user, later, when it is expensive.

## We had built this before, more than once

So more than once, internally and on client work, we hand-built a version of the check. We took the traces we had already run through the strong model, replayed them through a cheaper one, and compared the two outputs step by step to see where the cheap model held and where it broke. It was never a product. It was a folder of scripts and a spreadsheet, stood up under deadline because we needed the answer and no one was going to hand it to us. And every time we bothered, it paid for itself, usually by showing that a cheaper candidate matched our accepted output closely enough to merit a review of the swap.

## Everyone had the same problem

We assumed this was a quirk of how we worked. It was not. As we talked to other people building these systems, across teams and companies, we kept hearing the identical description of the identical problem. Everyone had defaulted to the frontier model. Everyone suspected they were overpaying. Almost nobody had a rigorous way to measure cheaper candidates against outputs they had accepted, so almost nobody changed anything, because the downside of a silent quality regression was scarier than the bill. At some point the pattern was obvious enough that guessing looked less like a habit and more like a liability. So we decided to build it properly, as a product, instead of rebuilding it by hand for the fourth time.

## A pull request, not a gateway

rightmodeler is that check, built properly: a validation framework for model swaps. It reads the model calls your app already recorded and replays the recorded steps on cheaper candidate models from your provider's live catalog. A judge from a different vendor, or your own evaluator, grades every answer against the output you accepted, the one you have already decided is good enough. It runs on your own traces, not synthetic prompts, so the results reflect your actual workload and not a general benchmark.

A swap that clears every release gate becomes a draft pull request that changes only model identifiers, with the evidence attached. Everything runs offline, beside your app, on your machine or in CI. Nothing sits in your request path, routes your traffic, or adds a hop to a request. You read the evidence, and you decide whether the change merges.

The part we are most attached to is that it can say no. When the cheaper model's outputs do not hold up, or the sample is too thin to be sure, it declines to recommend the swap and tells you so. A tool that always finds savings is not measuring anything. The value is a report you can inspect in both directions, including the boring, expensive result where there is not enough evidence to recommend a change.

## The bottleneck was the work

We spent years picking models by feel and calling it judgment. It was not judgment. It was a guess we had stopped noticing. The fix was never a better instinct. It was evidence drawn from traces we had already run, showing which candidates matched accepted outputs closely enough to review.

Looking back, the guessing was a symptom. The bottleneck was always the human work in the loop, the work of evaluating every model change by hand: noticing the release, pulling real traces, building a replay, grading the outputs, writing it up so it survived review, migrating, and doing it all again when the next model shipped. With the evidence in front of us, the call took minutes. Producing the evidence took days, every time, so most of the time nobody produced it, and a guess filled the gap. rightmodeler takes that work out of the loop, not the judgment, starting with swaps to cheaper models. Today, the final yes stays yours.

We think software should maintain itself, and that autonomy is earned with evidence. Validation on your own traces is how rightmodeler earns it: the first step toward a system that maintains itself inside the policy you set, reached one validated change at a time.

Part three of our vision, [The job nobody can staff](https://www.rightmodeler.com/blog/the-job-nobody-can-staff), makes the case that the work in the loop belongs to software.

The honest next step is the same one we always took. Point it at your own traces and read what comes back.
`;
