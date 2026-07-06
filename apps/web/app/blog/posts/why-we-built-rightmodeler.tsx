// Post: "Why we built rightmodeler" — the founding story. A typed post module: `meta` (data) plus a
// `Body` composed from the prose primitives. Registered in ./index. Voice matches the landing page:
// measured, honest, evidence-driven. No accent hues in the copy; the accents live in the hero art.

import { Prose, Lead, P, PullQuote, A } from "../../components/blog/Prose";
import { H2 } from "../../components/blog/Prose";
import type { PostMeta } from "./types";

export const meta: PostMeta = {
  slug: "why-we-built-rightmodeler",
  title: "We were picking models by vibes. Then the bill arrived.",
  description:
    "We picked models by instinct for years, then defaulted to the frontier model and paid for it. rightmodeler proves which downgrades your traces can survive.",
  excerpt:
    "We shipped agentic systems for years while guessing which model belonged at which step. rightmodeler is the tool we kept rebuilding by hand to stop guessing, made properly.",
  kicker: "Founding story",
  date: "2026-07-05",
  readingMinutes: 5,
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
        carrying steps that did not need it and we had no clean way to prove it.
      </P>

      <H2>Not every step is a hard problem</H2>

      <P>
        Here is what we actually wanted, and it is not complicated. The same
        quality of output we were already shipping, with a cheaper model running
        on the layers that do not need a frontier brain. Most multi-agent
        architectures are not made of hard reasoning. They are made of plumbing.
        A step that extracts fields from a document. A step that routes a
        request to the right branch. A step that summarizes what happened so the
        next step has context. A cheap model is often perfectly good at all of
        it. gpt-4o-mini, llama-3.3-70b, or deepseek-chat can handle extraction
        and routing and summarizing without a meaningful drop in quality. The
        expensive model, claude-opus-4 or gpt-4.1, should be spending your money
        on the genuinely hard reasoning steps, not on every step by default.
      </P>

      <PullQuote>
        The expensive model should earn its price on the hard reasoning, not on
        every step that happens to sit next to it.
      </PullQuote>

      <P>
        The intuition is easy. Proving it for your system is the actual work. A
        blind swap is easy and worthless. You can drop gpt-4o-mini into a step
        in thirty seconds. What you cannot do in thirty seconds is know whether
        it quietly got worse. Cheaper models fail in ways that do not throw
        errors. The extraction still returns valid JSON, it is just wrong on the
        edge cases. The summary still reads fine, it just dropped the one detail
        that mattered downstream. You do not find out from a stack trace. You
        find out from a user, later, when it is expensive.
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
        itself, usually by telling us that some step we had been anxious about
        was safe to downgrade after all.
      </P>

      <H2>Everyone had the same problem</H2>

      <P>
        We assumed this was a quirk of how we worked. It was not. As we talked
        to other people building these systems, across teams and companies, we
        kept hearing the identical description of the identical problem.
        Everyone had defaulted to the frontier model. Everyone suspected they
        were overpaying. Almost nobody had a rigorous way to know which swaps
        were safe, so almost nobody swapped anything, because the downside of a
        silent quality regression was scarier than the bill. At some point the
        pattern was obvious enough that guessing looked less like a habit and
        more like a liability. So we decided to build it properly, as a product,
        instead of rebuilding it by hand for the fourth time.
      </P>

      <H2>A report, not a gateway</H2>

      <P>
        rightmodeler replays your real agent traces through cheaper models. For
        each step, it judges the cheaper model’s output against what you already
        shipped in production, the output you have already decided is good
        enough. Then it produces a recommendation report: which downgrades hold
        up under evidence, and which do not. It runs on your own traces, not
        synthetic prompts, so the results reflect your actual workload and not a
        benchmark. It is a report, not a runtime gateway. It does not sit in
        your request path, route your traffic, or add a hop to your latency
        budget. You read the evidence, and you decide what to change and when.
      </P>

      <P>
        The part we are most attached to is that it can say no. When the cheaper
        model’s outputs do not hold up, or the sample is too thin to be sure, it
        declines to recommend the swap and tells you so. A tool that always
        finds savings is not measuring anything. The value is a verdict you can
        trust in both directions, including the boring, expensive verdict where
        the frontier model was the right call all along.
      </P>

      <P>
        We spent years picking models by feel and calling it judgment. It was
        not judgment. It was a guess we had stopped noticing. The fix was never
        a better instinct. It was evidence, drawn from the traces you have
        already run, telling you which parts of your stack can get cheaper
        without getting worse. The honest way to find out is the same way we
        always found out. Point it at your own traces and read what comes back.
      </P>
    </Prose>
  );
}
