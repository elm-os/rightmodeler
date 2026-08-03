import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const webRoot = path.resolve(scriptDirectory, "..");

const emDashPattern = /\u2014|&mdash;|&#(?:8212|x2014);/giu;
const sourceExtensions = new Set([".ts", ".tsx", ".json", ".md", ".mdx"]);

function sourceKind(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function sourceFile(sourceText, filePath) {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind(filePath),
  );
}

export function listFiles(directory, predicate = () => true) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(entryPath, predicate)
      : predicate(entryPath)
        ? [entryPath]
        : [];
  });
}

function lineAndColumn(parsed, position) {
  const location = parsed.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function staticStringNodes(parsed) {
  const nodes = [];

  function visit(node) {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      nodes.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return nodes;
}

export function findEmDashViolations(sourceText, filePath) {
  const extension = path.extname(filePath);
  if (extension === ".json" || extension === ".md" || extension === ".mdx") {
    const visibleText =
      extension === ".json"
        ? sourceText
        : sourceText.replace(
            /<!--[\s\S]*?-->|{\s*\/\*[\s\S]*?\*\/\s*}/g,
            (comment) => comment.replace(/[^\n]/g, " "),
          );
    return [...visibleText.matchAll(emDashPattern)].map((match) => {
      const prefix = sourceText.slice(0, match.index);
      const lines = prefix.split("\n");
      return {
        filePath,
        line: lines.length,
        column: lines.at(-1).length + 1,
      };
    });
  }

  const parsed = sourceFile(sourceText, filePath);
  return staticStringNodes(parsed).flatMap((node) => {
    const text = node.getText(parsed);
    return [...text.matchAll(emDashPattern)].map((match) => {
      const location = lineAndColumn(
        parsed,
        node.getStart(parsed) + match.index,
      );
      return { filePath, ...location };
    });
  });
}

function variableInitializer(parsed, name) {
  let initializer;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return initializer;
}

function bodyReturnExpression(parsed) {
  let expression;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "Body" &&
      node.body
    ) {
      const statement = node.body.statements.find(ts.isReturnStatement);
      expression = statement?.expression;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return expression;
}

function unwrapParentheses(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function jsxVisibleText(node, parsed, filePath) {
  const current = unwrapParentheses(node);
  if (!current) return "";

  if (ts.isJsxText(current)) return current.getText(parsed);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }
  if (ts.isJsxExpression(current)) {
    if (!current.expression) return "";
    return jsxVisibleText(current.expression, parsed, filePath);
  }
  if (ts.isJsxElement(current)) {
    return current.children
      .map((child) => jsxVisibleText(child, parsed, filePath))
      .join(" ");
  }
  if (ts.isJsxFragment(current)) {
    return current.children
      .map((child) => jsxVisibleText(child, parsed, filePath))
      .join(" ");
  }
  if (ts.isJsxSelfClosingElement(current)) {
    const tagName = current.tagName.getText(parsed);
    if (/^[A-Z]/.test(tagName)) {
      throw new Error(
        `${path.relative(webRoot, filePath)}: Body contains unsupported self-closing component (${tagName}).`,
      );
    }
    return current.attributes.properties
      .filter(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          ["alt", "aria-label", "title"].includes(
            attribute.name.getText(parsed),
          ),
      )
      .map((attribute) =>
        attribute.initializer
          ? jsxVisibleText(attribute.initializer, parsed, filePath)
          : "",
      )
      .join(" ");
  }

  throw new Error(
    `${path.relative(webRoot, filePath)}: Body contains unsupported dynamic content (${ts.SyntaxKind[current.kind]}).`,
  );
}

function metaTitle(parsed, filePath) {
  const meta = variableInitializer(parsed, "meta");
  if (!meta || !ts.isObjectLiteralExpression(meta)) {
    throw new Error(
      `${path.relative(webRoot, filePath)}: missing static meta.`,
    );
  }
  const title = meta.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText(parsed) === "title",
  );
  if (
    !title ||
    !ts.isPropertyAssignment(title) ||
    !ts.isStringLiteral(title.initializer)
  ) {
    throw new Error(
      `${path.relative(webRoot, filePath)}: missing static meta.title.`,
    );
  }
  return title.initializer.text;
}

function markdownText(parsed, filePath) {
  const markdown = variableInitializer(parsed, "markdown");
  if (!markdown || !ts.isNoSubstitutionTemplateLiteral(markdown)) {
    throw new Error(
      `${path.relative(webRoot, filePath)}: markdown must be a static template literal.`,
    );
  }
  return markdown.text;
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    ldquo: '"',
    lt: "<",
    nbsp: " ",
    quot: '"',
    rdquo: '"',
    rsquo: "'",
  };

  return value
    .replace(
      /&([a-z]+);/gi,
      (entity, name) => named[name.toLowerCase()] ?? entity,
    )
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function markdownToText(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/gm, " ")
    .replace(/[*~`]/g, "")
    .replace(/(?<![\p{L}\p{N}])_+/gu, "")
    .replace(/_+(?![\p{L}\p{N}])/gu, "");
}

function normalizeVisibleText(value) {
  return decodeEntities(value)
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function findBlogParityViolation(sourceText, filePath) {
  const parsed = sourceFile(sourceText, filePath);
  const body = bodyReturnExpression(parsed);
  if (!body) {
    throw new Error(
      `${path.relative(webRoot, filePath)}: missing Body return.`,
    );
  }

  const bodyText = normalizeVisibleText(
    `${metaTitle(parsed, filePath)} ${jsxVisibleText(body, parsed, filePath)}`,
  );
  const markdown = normalizeVisibleText(
    markdownToText(markdownText(parsed, filePath)),
  );
  if (bodyText === markdown) return null;

  const index = firstDifference(bodyText, markdown);
  const start = Math.max(0, index - 40);
  const end = index + 80;
  return {
    filePath,
    bodyExcerpt: bodyText.slice(start, end),
    markdownExcerpt: markdown.slice(start, end),
  };
}

export function readProductFacts(sourceText, filePath) {
  const parsed = sourceFile(sourceText, filePath);
  const sources = variableInitializer(parsed, "TRACE_SOURCES");
  const scorecard = variableInitializer(parsed, "ILLUSTRATIVE_SCORECARD");

  if (!sources || !ts.isAsExpression(sources)) {
    throw new Error("TRACE_SOURCES must remain a const array.");
  }
  if (!scorecard || !ts.isAsExpression(scorecard)) {
    throw new Error("ILLUSTRATIVE_SCORECARD must remain a const object.");
  }

  const sourceArray = sources.expression;
  const scoreObject = scorecard.expression;
  if (
    !ts.isArrayLiteralExpression(sourceArray) ||
    !ts.isObjectLiteralExpression(scoreObject)
  ) {
    throw new Error("Product facts must remain statically readable.");
  }

  return {
    traceSourceCount: sourceArray.elements.length,
    scores: scoreObject.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.initializer) &&
      /^(?:0|1)\.\d{2}$/.test(property.initializer.text)
        ? [property.initializer.text]
        : [],
    ),
  };
}

export function findProductFactHardcodes(sourceText, filePath, facts) {
  const parsed = sourceFile(sourceText, filePath);
  const countPattern = new RegExp(
    "\\b(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\\s+(?:(?:trace|source)\\s+)?(?:sources?|formats?)\\b",
    "gi",
  );
  const escapedScores = facts.scores.map((score) =>
    score.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const scorePattern =
    escapedScores.length > 0
      ? new RegExp(`(?<![\\d.])(?:${escapedScores.join("|")})(?![\\d.])`, "g")
      : null;

  return staticStringNodes(parsed).flatMap((node) => {
    const text = node.getText(parsed);
    const matches = [
      ...text.matchAll(countPattern),
      ...(scorePattern ? text.matchAll(scorePattern) : []),
    ];
    return matches.map((match) => {
      const location = lineAndColumn(
        parsed,
        node.getStart(parsed) + match.index,
      );
      return { filePath, ...location, value: match[0] };
    });
  });
}

function formatLocation(diagnostic) {
  return `${path.relative(webRoot, diagnostic.filePath)}:${diagnostic.line}:${diagnostic.column}`;
}

function resolveRequestedFiles(values) {
  return values.map((value) => path.resolve(webRoot, value));
}

function runEmDashCheck(files) {
  const violations = files.flatMap((filePath) =>
    findEmDashViolations(fs.readFileSync(filePath, "utf8"), filePath),
  );
  if (violations.length === 0) {
    console.log(`Visible-copy em dash check passed (${files.length} files).`);
    return false;
  }

  console.error("Visible-copy em dash check failed:");
  for (const violation of violations) {
    console.error(`  ${formatLocation(violation)}`);
  }
  return true;
}

function runBlogParityCheck(files) {
  const violations = files
    .map((filePath) =>
      findBlogParityViolation(fs.readFileSync(filePath, "utf8"), filePath),
    )
    .filter(Boolean);
  if (violations.length === 0) {
    console.log(
      `Blog JSX/markdown parity check passed (${files.length} posts).`,
    );
    return false;
  }

  console.error("Blog JSX/markdown parity check failed:");
  for (const violation of violations) {
    console.error(`  ${path.relative(webRoot, violation.filePath)}`);
    console.error(`    JSX:      ${violation.bodyExcerpt}`);
    console.error(`    Markdown: ${violation.markdownExcerpt}`);
  }
  return true;
}

function main() {
  const [mode, ...requested] = process.argv.slice(2);
  const sourceFiles = listFiles(path.join(webRoot, "src"), (filePath) =>
    sourceExtensions.has(path.extname(filePath)),
  );
  const blogFiles = listFiles(
    path.join(webRoot, "src", "content", "blog"),
    (filePath) =>
      filePath.endsWith(".tsx") &&
      !filePath.endsWith(`${path.sep}types.tsx`) &&
      !filePath.endsWith(`${path.sep}index.tsx`),
  );

  if (mode === "--em-dash-only") {
    process.exitCode = runEmDashCheck(
      requested.length > 0 ? resolveRequestedFiles(requested) : sourceFiles,
    )
      ? 1
      : 0;
    return;
  }
  if (mode === "--blog-parity-only") {
    process.exitCode = runBlogParityCheck(
      requested.length > 0 ? resolveRequestedFiles(requested) : blogFiles,
    )
      ? 1
      : 0;
    return;
  }
  if (mode) {
    throw new Error(`Unknown argument: ${mode}`);
  }

  const emDashFailed = runEmDashCheck(sourceFiles);
  const parityFailed = runBlogParityCheck(blogFiles);
  process.exitCode = emDashFailed || parityFailed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
