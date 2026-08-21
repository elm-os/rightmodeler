// Assertions against the prerendered HTML, which is the artifact crawlers and agents actually
// read. Root `pnpm check` runs through turbo, whose `check` task dependsOn `build`, so the output
// is always present in CI. A bare local `pnpm test` on a clean tree has no .next, and skipping
// there beats a false red.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { webRoot } from "./check-content.mjs";

const appDir = path.join(webRoot, ".next", "server", "app");
const built = fs.existsSync(path.join(appDir, "index.html"));
const gate = built || process.env.CI ? test : test.skip;

function allBuiltHtml(dir = appDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return allBuiltHtml(full);
    return entry.name.endsWith(".html") ? [full] : [];
  });
}

const read = (file) => fs.readFileSync(file, "utf8");
const rel = (file) => path.relative(appDir, file);

function visibleText(source) {
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headingLevels(source) {
  return [...source.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]));
}

gate(
  "the home page outline starts at h1, reaches h3, and skips no level",
  () => {
    const levels = headingLevels(read(path.join(appDir, "index.html")));
    assert.equal(
      levels.filter((l) => l === 1).length,
      1,
      "expected exactly one h1",
    );
    assert.equal(levels[0], 1, "the first heading must be the h1");
    assert.ok(levels.includes(2), "no h2: the outline is flat");
    assert.ok(levels.includes(3), "no h3: the outline is still flat");
    let deepest = 1;
    for (const level of levels) {
      assert.ok(
        level <= deepest + 1,
        `h${level} follows h${deepest}: skipped a level`,
      );
      deepest = Math.max(deepest, level);
    }
  },
);

gate("no prerendered page ships a counter frozen at zero", () => {
  // useReducedMotion() returns null on the server, so branching rendered output on it used to
  // server-render the proof numbers as 0. A no-JS reader saw "0%" where the evidence belongs.
  for (const file of allBuiltHtml()) {
    for (const match of read(file).matchAll(
      /<span class="tabular-nums[^"]*">([^<]*)</g,
    )) {
      assert.ok(
        !/^0(\.0+)?%?$/.test(match[1].trim()),
        `${rel(file)}: an AnimatedNumber server-rendered as "${match[1]}"`,
      );
    }
  }
});

gate("nothing server-renders invisible without a no-JS escape hatch", () => {
  // Reveal enters with whileInView, which needs JavaScript. Without the noscript rule in
  // app/layout.tsx every revealed element sits at opacity:0 forever and a reader with JS off
  // sees a blank page.
  for (const file of allBuiltHtml()) {
    const html = read(file);
    if (!/style="[^"]*opacity:0/.test(html)) continue;
    assert.match(
      html,
      /<noscript><style>\[data-reveal\]\{opacity:1!important/,
      `${rel(file)} hides content at opacity:0 with no noscript override`,
    );
    for (const match of html.matchAll(
      /<[a-z][^>]*style="[^"]*opacity:0[^"]*"[^>]*>/gi,
    )) {
      assert.match(
        match[0],
        /data-reveal/,
        `${rel(file)}: an element hides itself at opacity:0 without data-reveal, so the ` +
          `noscript rule cannot reach it`,
      );
    }
  }
});

gate("the home page carries an Organization with contact points", () => {
  const html = read(path.join(appDir, "index.html"));
  const blocks = [
    ...html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ].map((m) => JSON.parse(m[1]));
  const org = blocks.find((b) => b["@type"] === "Organization");
  assert.ok(org, "no Organization node on the home page");
  assert.ok(org.email, "the Organization has no email");
  assert.ok(
    Array.isArray(org.contactPoint) && org.contactPoint.length > 0,
    "no contactPoint",
  );
  for (const point of org.contactPoint) {
    assert.ok(point.contactType, "a contactPoint has no contactType");
    assert.ok(point.email, "a contactPoint has no email");
  }
});

gate("every page advertises its Markdown sibling", () => {
  for (const file of [
    "index.html",
    "about.html",
    "contact.html",
    "how-it-works.html",
  ]) {
    const html = read(path.join(appDir, file));
    assert.match(
      html,
      /<link rel="alternate" type="text\/markdown" href="[^"]+\.md"/,
      `${file} has no rel="alternate" pointing at its .md sibling`,
    );
  }
});

gate(
  "content efficiency is reported, and the agent-facing pages hold their floor",
  () => {
    // Finding 6 of the audit. The home page is knowingly below 5% until it gains prose; this
    // records the number every build so the gap stays visible instead of being forgotten, and
    // fails if a page that already clears the bar regresses below it.
    const FLOOR = { "how-it-works.html": 0.05 };
    const rows = [];
    for (const file of allBuiltHtml()) {
      const html = read(file);
      // Partial-prerender shells for a dynamic segment are empty placeholders, not pages.
      if (html.length === 0) continue;
      const ratio = visibleText(html).length / html.length;
      rows.push(`${rel(file).padEnd(34)} ${(ratio * 100).toFixed(2)}%`);
      const floor = FLOOR[rel(file)];
      if (floor !== undefined) {
        assert.ok(
          ratio >= floor,
          `${rel(file)}: ${(ratio * 100).toFixed(2)}% is below its floor`,
        );
      }
    }
    console.log(`\ncontent efficiency:\n${rows.sort().join("\n")}\n`);
  },
);
