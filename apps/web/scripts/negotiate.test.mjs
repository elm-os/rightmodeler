// Conformance tests for the Accept negotiator (src/lib/negotiate.ts).
//
// The expectations are not invented: every row was captured by probing acceptmarkdown.com's own
// reference implementation with curl, so "what the spec means" is settled by what the spec's
// author ships. Node 24 strips types natively, so the .ts module imports directly.

import assert from "node:assert/strict";
import test from "node:test";
import {
  decideProxyAction,
  NOT_ACCEPTABLE_BODY,
  parseAccept,
  selectRepresentation,
  VARY,
} from "../src/lib/negotiate.ts";
import { markdownHandlerPath } from "../src/lib/markdown-routes.ts";

const HTML = "text/html";
const MD = "text/markdown";
const NONE = "not-acceptable";

// [Accept header, expected representation, why it matters]
const VECTORS = [
  // The six vectors acceptmarkdown.com's scorecard checks directly.
  [MD, MD, "bare markdown request"],
  ["text/markdown, text/html;q=0.8", MD, "markdown preferred by q"],
  [HTML, HTML, "bare html request"],
  ["text/markdown;q=0, text/html", HTML, "q=0 is an explicit rejection"],
  [null, HTML, "missing Accept means no constraint, never 406"],
  ["*/*", HTML, "wildcard means no constraint"],

  // RFC 9110 12.5.1: a more specific range overrides a less specific one regardless of q.
  // These are the cases a substring or naive-sort implementation gets wrong.
  [
    "text/html;q=0, */*;q=1",
    MD,
    "html explicitly rejected, wildcard carries markdown",
  ],
  ["text/markdown;q=0, */*;q=1", HTML, "mirror of the above"],
  ["*/*, text/html;q=0", MD, "same rule with the ranges reversed"],
  [
    "text/*;q=0, text/markdown",
    MD,
    "exact range beats a rejected subtype wildcard",
  ],
  ["text/markdown, text/*", MD, "equal q, exact beats text/*"],
  ["text/*", HTML, "equal q and equal specificity falls to server preference"],

  // q handling.
  ["text/markdown;q=0.5, text/html;q=0.4", MD, "higher q wins"],
  ["text/markdown;q=0.4, text/html;q=0.5", HTML, "higher q wins the other way"],
  [
    "text/markdown;q=1.0, text/html;q=1",
    HTML,
    "exact tie falls to server preference",
  ],
  [
    "text/markdown;charset=utf-8;q=0.9, text/html",
    HTML,
    "q is found after another parameter",
  ],
  [
    "text/markdown ; q=0.9 , text/html;q=0.8",
    MD,
    "optional whitespace around delimiters",
  ],
  ["TEXT/MARKDOWN", MD, "media types are case-insensitive"],
  [
    "text/html;Q=0.5, text/markdown;q=0.4",
    HTML,
    "parameter names are case-insensitive",
  ],
  [
    "text/html;q=abc",
    HTML,
    "a malformed q is treated as absent, never as a rejection",
  ],
  ["text/markdown;q=1.5", MD, "q above 1 clamps to 1"],
  ["text/markdown;q=-1", NONE, "q below 0 clamps to 0, which is a rejection"],

  // 406: every representation is either unmatched or explicitly rejected.
  ["application/json", NONE, "we produce neither"],
  ["application/pdf", NONE, "we produce neither"],
  ["image/png, application/pdf", NONE, "we produce neither"],
  ["text/plain", NONE, "text/plain is not one of our representations"],
  ["text/html;q=0, text/markdown;q=0", NONE, "both rejected"],
  ["*/*;q=0", NONE, "everything rejected"],
  ["text/markdown;q=0", NONE, "markdown rejected and html never matched"],

  // Never 406 on a header we simply could not read.
  ["", HTML, "empty header"],
  ["   ", HTML, "whitespace header"],
  ["garbage", HTML, "no slash, unparseable"],
  [",,;q=,", HTML, "entirely malformed"],

  // Real clients.
  [
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    HTML,
    "Chrome",
  ],
  [
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    HTML,
    "Safari",
  ],
  ["text/plain, */*;q=0.1", HTML, "a lazy client that still allows anything"],

  // The deprecated pre-registration spelling still reaches markdown.
  [
    "text/x-markdown",
    MD,
    "RFC 7763 superseded this spelling but clients still send it",
  ],
];

for (const [header, expected, why] of VECTORS) {
  test(`Accept: ${JSON.stringify(header)} -> ${expected} (${why})`, () => {
    assert.equal(selectRepresentation(header), expected);
  });
}

test("parseAccept preserves client order and drops unparseable ranges", () => {
  const ranges = parseAccept("text/markdown;q=0.9, garbage, text/*, */*;q=0.1");
  assert.deepEqual(
    ranges.map((r) => `${r.type}/${r.subtype}@${r.q}#${r.specificity}`),
    ["text/markdown@0.9#3", "text/*@1#2", "*/*@0.1#1"],
  );
});

test("parseAccept returns an empty list rather than throwing on junk", () => {
  assert.deepEqual(parseAccept(undefined), []);
  assert.deepEqual(parseAccept("///"), []);
});

const decide = (pathname, accept, method = "GET") =>
  decideProxyAction({ pathname, accept, method, markdownHandlerPath });

test("a markdown request rewrites to the handler", () => {
  assert.deepEqual(decide("/about", MD), {
    type: "rewrite",
    destination: "/api/markdown/about",
  });
});

test("the root rewrites to the bare handler path", () => {
  assert.deepEqual(decide("/", MD), {
    type: "rewrite",
    destination: "/api/markdown",
  });
});

test("nested paths keep every segment", () => {
  assert.equal(
    decide("/blog/the-tuesday-problem", MD).destination,
    "/api/markdown/blog/the-tuesday-problem",
  );
  assert.equal(
    decide("/use-cases/reduce-llm-costs", MD).destination,
    "/api/markdown/use-cases/reduce-llm-costs",
  );
});

test("an unknown path still rewrites, so the handler owns the 404", () => {
  assert.equal(decide("/nope", MD).type, "rewrite");
});

test("a browser passes through untouched", () => {
  assert.deepEqual(
    decide("/about", "text/html,application/xhtml+xml,*/*;q=0.8"),
    {
      type: "pass",
    },
  );
});

test("an unsatisfiable Accept is rejected with a 406 naming both representations", () => {
  const action = decide("/about", "application/json");
  assert.equal(action.type, "reject");
  assert.equal(action.status, 406);
  assert.equal(action.contentType, "text/plain; charset=utf-8");
  assert.match(action.body, /text\/html/);
  assert.match(action.body, /text\/markdown/);
  assert.equal(action.body, NOT_ACCEPTABLE_BODY);
});

test("a write is never negotiated, whatever it asks for", () => {
  assert.deepEqual(decide("/api/feedback", MD, "POST"), { type: "pass" });
  assert.deepEqual(decide("/about", "application/json", "POST"), {
    type: "pass",
  });
});

test("HEAD negotiates exactly as GET does", () => {
  assert.deepEqual(decide("/about", MD, "HEAD"), decide("/about", MD, "GET"));
});

test("Vary carries Accept alongside every token Next sets itself", () => {
  const tokens = VARY.toLowerCase()
    .split(",")
    .map((t) => t.trim());
  for (const required of [
    "accept",
    "rsc",
    "next-router-state-tree",
    "next-router-prefetch",
    "next-router-segment-prefetch",
  ]) {
    assert.equal(
      tokens.filter((t) => t === required).length,
      1,
      `Vary should list ${required} exactly once`,
    );
  }
});
