// Post: "Nobody can predict the bill" — research notes on Bai et al., arXiv:2604.22750, "How Do AI
// Agents Spend Your Money?". A typed post module: `meta` (data) plus a `Body` composed from the
// prose primitives. Registered in ./index. Voice matches the vision series: measured, story-first,
// plain-language. Every figure quoted here was checked against the paper. The section on where the
// variance finding cuts against our own method is deliberate and stays in.

import { A, H2, Lead, P, Prose, PullQuote } from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "nobody-can-predict-the-bill",
  title: "Nobody can predict the bill.",
  description:
    "Eight frontier models, 500 real GitHub issues, four runs each. A new paper finds nobody can predict what an agent task costs, including the agent.",
  excerpt:
    "You approve the run and nobody knows the price, including the agent about to spend it. What a new paper on agent token costs actually measured, and what it changes about picking models.",
  kicker: "Research · Token economics",
  date: "2026-08-06",
  readingMinutes: 7,
  hero: {
    src: "/blog/nobody-can-predict-the-bill-hero.jpg",
    alt: "A warm parchment field where one short muted stroke stops early and a long grain-textured stroke runs on in rightmodeler's violet and orange brand accents.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        You approve the agent to go fix a bug. It reads the repository, runs the
        tests, edits a file, runs the tests again, and somewhere in there it
        spends your money. Twenty cents or twenty dollars, you will not know
        which until it stops. Here is the part that should bother you more:
        neither will the agent.
      </Lead>

      <P>
        Somebody finally measured this properly. Researchers from Michigan,
        Stanford, MIT, Google DeepMind, and All Hands AI, the team behind the
        OpenHands agent, ran eight frontier models across 500 real GitHub
        issues, four separate times each, and recorded every token. Their paper
        is called{" "}
        <A href="https://arxiv.org/abs/2604.22750">
          How Do AI Agents Spend Your Money?
        </A>{" "}
        We read all of it. The headline result is uncomfortable: nobody can tell
        you what an agent task will cost before it runs. Not an experienced
        engineer reading the ticket. Not the agent about to do the work.
      </P>

      <H2>An agent is not a chatbot with tools</H2>

      <P>
        Start with the unit you are billed in. Models charge by the token,
        roughly a fragment of a word, and there are two kinds. Input tokens are
        everything the model reads. Output tokens are everything it writes. In a
        chat those stay close to even: you send a paragraph, it sends one back.
      </P>

      <P>
        An agent is not even. On every turn, the entire conversation so far gets
        fed back in: the original issue, every file it opened, every failing
        test, every patch it already tried. Turn thirty carries the full weight
        of turns one through twenty-nine. The paper puts a number on it. In
        agentic coding the model reads about 154 tokens for every single token
        it writes. In chat it reads a little over one. Your bill lives in that
        ratio.
      </P>

      <P>
        The absolute figures land harder. In their data a single-turn coding
        question ran about 1,200 tokens and under two cents. One agentic coding
        task averaged 4.17 million tokens and about $1.86. That is roughly three
        and a half thousand times the consumption for what looks, from the
        outside, like the same kind of work. If you have ever opened an agent
        invoice and assumed something was misconfigured, probably nothing was.
        That is the price of the format.
      </P>

      <H2>Three ways to guess, and why all three fail</H2>

      <P>
        The first instinct is to ask a person. The benchmark in this study,
        SWE-bench Verified, ships with difficulty labels: professional engineers
        read every issue and estimated whether it was a fifteen-minute fix, an
        hour, or most of a day. These are good labels, written by people who do
        the job.
      </P>

      <P>
        They barely track cost. The paper measures the rank correlation at 0.32.
        In plain terms that means the ordering is related but only loosely. If
        it were 1.0, the hardest-looking ticket would always be the priciest
        one. At 0.32, 6.7% of the tickets an expert called trivial burned more
        tokens than the average all-day ticket, and 11.1% of the all-day tickets
        came in cheaper than the average trivial one. What feels hard to a human
        and what costs a lot on a machine are two different quantities that
        happen to overlap a little.
      </P>

      <P>
        The second instinct is better: ask the agent. It can read the
        repository. It can run the tests. Let it look around first and estimate
        its own bill before it commits to anything. That is exactly the
        experiment in the second half of the paper, using the same agent with
        the same tools, told to produce a number instead of a fix.
      </P>

      <P>
        The best correlation any model reached was 0.39. Perfect foresight is
        1.0 and a coin flip is 0, so 0.39 is a real signal and a useless budget.
        Worse, the errors all ran the same way. Every model tested guessed low.
        Not on average, not usually, but systematically, across all eight, and
        the miss was widest on precisely the input tokens that dominate the
        bill. Two of them burned more than twice the cost of the task itself to
        produce the estimate, and still came in under.
      </P>

      <PullQuote>
        An agent that spends twice the price of a job to produce a low estimate
        has not budgeted anything. It has bought you a second bill.
      </PullQuote>

      <P>
        The third instinct is to stop theorizing and just run it once, then use
        that number. This is where the paper is bluntest. Every task was run
        four separate times: same agent, same model, same issue. Across those
        repeats, total token usage varied by as much as thirty times. Between
        the expensive run and the cheap run of an ordinary pair, roughly double.
        Nothing changed except chance.
      </P>

      <H2>Spending more does not buy more</H2>

      <P>
        At this point it stops being an accounting problem. If the expensive
        runs were expensive because the agent was thinking harder, you would at
        least be buying something. So the authors ranked the four runs of each
        task from cheapest to priciest and checked which ones actually solved
        the problem. Accuracy improved from the cheapest run to the second
        cheapest, and then flattened. The most expensive attempt at a task was
        not the most likely to succeed.
      </P>

      <P>
        Then they looked at what those expensive runs were physically doing.
        Opening the same file again. Editing the same file again. Reading back
        something written three turns ago. For the costliest models, around half
        of all file operations were repeats on a file the agent had already
        handled. That is not deeper reasoning, that is an agent circling. And
        every lap gets appended to the context it pays to re-read on the next
        turn, which is how a stuck agent becomes an expensive one.
      </P>

      <H2>Waste is a habit of the model, not a property of the task</H2>

      <P>
        The finding that changed how we think about our own product is the
        quietest one in the paper. Across the same 500 tasks, Kimi-K2 and Claude
        Sonnet 4.5 each spent over 1.5 million tokens more than GPT-5. The
        obvious objection writes itself: maybe the expensive models were
        attempting the harder problems, or grinding longer on the ones they
        lost.
      </P>

      <P>
        So the authors removed that explanation. They pulled out the 230 tasks
        that every model solved and the 100 that every model failed, and looked
        again. The ranking held. On identical problems, with identical outcomes,
        some models simply spend far more than others. Token efficiency turns
        out to be a trait a model brings with it, closer to verbosity than to
        difficulty.
      </P>

      <P>
        That one result is what makes model routing a real lever instead of a
        hope. If cost were a property of the task, swapping models would only
        move the same bill around. Because it is a property of the model, the
        same step can be handed to a different one and genuinely cost less for
        the same output. And because expert intuition only tracks cost at 0.32,
        you cannot work out which steps to hand over by staring at your pipeline
        and deciding which parts look hard. You have to measure them.
      </P>

      <H2>Where this cuts against us</H2>

      <P>
        It would be dishonest to write all that up without naming the part that
        is inconvenient for us. rightmodeler replays your real traces through
        cheaper candidate models and measures the results against outputs you
        already accepted. The variance finding applies to that too. A single
        replay of a single trace is one draw from a distribution this paper
        shows to be wide and lopsided. One replay proves very little.
      </P>

      <P>
        It is why the tool reports sample size beside every recommendation, and
        why it abstains rather than guessing when the evidence under a step is
        thin. A tool that always finds you a saving is not measuring anything.
        We cannot make agent cost predictable. Neither can anyone else, which is
        rather the point. What we can do is stop asking anybody to forecast it.
      </P>

      <H2>What to do on Monday</H2>

      <P>
        The practical version of this paper is smaller than the paper. Stop
        reading a model&rsquo;s list price as its cost to you, because in
        agentic work the bill is dominated by re-reading context that no pricing
        table shows. Stop assigning models to steps by how hard those steps
        look, because that instinct has now been measured and it is weak.
        Measure the steps you actually run, on the traces you already have, and
        let the result choose.
      </P>

      <P>
        That is all the{" "}
        <A href="https://github.com/elm-os/rightmodeler">rightmodeler skill</A>{" "}
        does, and it is one command to install and free to run against your own
        traces. For the downstream version of this problem, an invoice that
        arrives as a single number with no line items, we wrote about that in{" "}
        <A href="/blog/the-bill-nobody-can-read">the bill nobody can read</A>.
        And read the paper. It is careful work, honest about its own limits, and
        worth the hour.
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-context.txt and any LLM-facing surface. Kept in sync with
// Body above by hand.
export const markdown = `# Nobody can predict the bill.

You approve the agent to go fix a bug. It reads the repository, runs the tests, edits a file, runs the tests again, and somewhere in there it spends your money. Twenty cents or twenty dollars, you will not know which until it stops. Here is the part that should bother you more: neither will the agent.

Somebody finally measured this properly. Researchers from Michigan, Stanford, MIT, Google DeepMind, and All Hands AI, the team behind the OpenHands agent, ran eight frontier models across 500 real GitHub issues, four separate times each, and recorded every token. Their paper is called [How Do AI Agents Spend Your Money?](https://arxiv.org/abs/2604.22750) We read all of it. The headline result is uncomfortable: nobody can tell you what an agent task will cost before it runs. Not an experienced engineer reading the ticket. Not the agent about to do the work.

## An agent is not a chatbot with tools

Start with the unit you are billed in. Models charge by the token, roughly a fragment of a word, and there are two kinds. Input tokens are everything the model reads. Output tokens are everything it writes. In a chat those stay close to even: you send a paragraph, it sends one back.

An agent is not even. On every turn, the entire conversation so far gets fed back in: the original issue, every file it opened, every failing test, every patch it already tried. Turn thirty carries the full weight of turns one through twenty-nine. The paper puts a number on it. In agentic coding the model reads about 154 tokens for every single token it writes. In chat it reads a little over one. Your bill lives in that ratio.

The absolute figures land harder. In their data a single-turn coding question ran about 1,200 tokens and under two cents. One agentic coding task averaged 4.17 million tokens and about $1.86. That is roughly three and a half thousand times the consumption for what looks, from the outside, like the same kind of work. If you have ever opened an agent invoice and assumed something was misconfigured, probably nothing was. That is the price of the format.

## Three ways to guess, and why all three fail

The first instinct is to ask a person. The benchmark in this study, SWE-bench Verified, ships with difficulty labels: professional engineers read every issue and estimated whether it was a fifteen-minute fix, an hour, or most of a day. These are good labels, written by people who do the job.

They barely track cost. The paper measures the rank correlation at 0.32. In plain terms that means the ordering is related but only loosely. If it were 1.0, the hardest-looking ticket would always be the priciest one. At 0.32, 6.7% of the tickets an expert called trivial burned more tokens than the average all-day ticket, and 11.1% of the all-day tickets came in cheaper than the average trivial one. What feels hard to a human and what costs a lot on a machine are two different quantities that happen to overlap a little.

The second instinct is better: ask the agent. It can read the repository. It can run the tests. Let it look around first and estimate its own bill before it commits to anything. That is exactly the experiment in the second half of the paper, using the same agent with the same tools, told to produce a number instead of a fix.

The best correlation any model reached was 0.39. Perfect foresight is 1.0 and a coin flip is 0, so 0.39 is a real signal and a useless budget. Worse, the errors all ran the same way. Every model tested guessed low. Not on average, not usually, but systematically, across all eight, and the miss was widest on precisely the input tokens that dominate the bill. Two of them burned more than twice the cost of the task itself to produce the estimate, and still came in under.

> An agent that spends twice the price of a job to produce a low estimate has not budgeted anything. It has bought you a second bill.

The third instinct is to stop theorizing and just run it once, then use that number. This is where the paper is bluntest. Every task was run four separate times: same agent, same model, same issue. Across those repeats, total token usage varied by as much as thirty times. Between the expensive run and the cheap run of an ordinary pair, roughly double. Nothing changed except chance.

## Spending more does not buy more

At this point it stops being an accounting problem. If the expensive runs were expensive because the agent was thinking harder, you would at least be buying something. So the authors ranked the four runs of each task from cheapest to priciest and checked which ones actually solved the problem. Accuracy improved from the cheapest run to the second cheapest, and then flattened. The most expensive attempt at a task was not the most likely to succeed.

Then they looked at what those expensive runs were physically doing. Opening the same file again. Editing the same file again. Reading back something written three turns ago. For the costliest models, around half of all file operations were repeats on a file the agent had already handled. That is not deeper reasoning, that is an agent circling. And every lap gets appended to the context it pays to re-read on the next turn, which is how a stuck agent becomes an expensive one.

## Waste is a habit of the model, not a property of the task

The finding that changed how we think about our own product is the quietest one in the paper. Across the same 500 tasks, Kimi-K2 and Claude Sonnet 4.5 each spent over 1.5 million tokens more than GPT-5. The obvious objection writes itself: maybe the expensive models were attempting the harder problems, or grinding longer on the ones they lost.

So the authors removed that explanation. They pulled out the 230 tasks that every model solved and the 100 that every model failed, and looked again. The ranking held. On identical problems, with identical outcomes, some models simply spend far more than others. Token efficiency turns out to be a trait a model brings with it, closer to verbosity than to difficulty.

That one result is what makes model routing a real lever instead of a hope. If cost were a property of the task, swapping models would only move the same bill around. Because it is a property of the model, the same step can be handed to a different one and genuinely cost less for the same output. And because expert intuition only tracks cost at 0.32, you cannot work out which steps to hand over by staring at your pipeline and deciding which parts look hard. You have to measure them.

## Where this cuts against us

It would be dishonest to write all that up without naming the part that is inconvenient for us. rightmodeler replays your real traces through cheaper candidate models and measures the results against outputs you already accepted. The variance finding applies to that too. A single replay of a single trace is one draw from a distribution this paper shows to be wide and lopsided. One replay proves very little.

It is why the tool reports sample size beside every recommendation, and why it abstains rather than guessing when the evidence under a step is thin. A tool that always finds you a saving is not measuring anything. We cannot make agent cost predictable. Neither can anyone else, which is rather the point. What we can do is stop asking anybody to forecast it.

## What to do on Monday

The practical version of this paper is smaller than the paper. Stop reading a model's list price as its cost to you, because in agentic work the bill is dominated by re-reading context that no pricing table shows. Stop assigning models to steps by how hard those steps look, because that instinct has now been measured and it is weak. Measure the steps you actually run, on the traces you already have, and let the result choose.

That is all the [rightmodeler skill](https://github.com/elm-os/rightmodeler) does, and it is one command to install and free to run against your own traces. For the downstream version of this problem, an invoice that arrives as a single number with no line items, we wrote about that in [the bill nobody can read](https://www.rightmodeler.com/blog/the-bill-nobody-can-read). And read the paper. It is careful work, honest about its own limits, and worth the hour.
`;
