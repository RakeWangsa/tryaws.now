import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The guard every kit component file must pass (WPU-T2). It reads the source with the TypeScript
// parser, so a rule cannot be dodged by spacing or by a comment. It passes with no component present.

const here = fileURLToPath(new URL("./", import.meta.url));

/** Components that are Client Components: the only files that may carry "use client". */
export const CLIENT_COMPONENTS = [
  "Tabs",
  "Accordion",
  "Modal",
  "ConfirmDestroy",
  "Toast",
  "SubmitButton",
  "PlanPicker",
  "SecretReveal",
  "CopyField",
];

const HAS_LETTER = /\p{L}/u;
const ALLOWED_IMPORTS = new Set(["react", "react-dom", "react-dom/server", "next-intl"]);
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "title",
  "placeholder",
  "label",
]);
const BANNED_IDENTIFIERS = new Map<string, string>([
  ["dangerouslySetInnerHTML", "dangerouslySetInnerHTML"],
  ["innerHTML", "innerHTML"],
  ["localStorage", "localStorage"],
  ["sessionStorage", "sessionStorage"],
  ["XMLHttpRequest", "XMLHttpRequest"],
  ["sendBeacon", "sendBeacon"],
]);

function importAllowed(source: string): boolean {
  if (source.startsWith("./") || source.startsWith("../")) return true;
  if (ALLOWED_IMPORTS.has(source)) return true;
  return source.startsWith("@radix-ui/");
}

/** The text of a literal child or value, when it is a plain string; else undefined. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
  }
  return undefined;
}

/** true when the file starts with the directive "use client". */
export function hasUseClient(text: string): boolean {
  const sf = ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

/** The rule violations of one component source, each as `name:line: message`. */
export function checkSource(name: string, text: string): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push(`${name}:${line + 1}: ${message}`);
  };
  const checkImport = (node: ts.Node, source: string): void => {
    if (!importAllowed(source)) report(node, `import of "${source}" is not allowed in the kit`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const attr = node.name.getText(sf);
      if (attr === "style") report(node, "inline style attribute (U4): use a tc-* class");
      if (TEXT_ATTRIBUTES.has(attr) && node.initializer) {
        const value = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        const text = value ? literalText(value) : undefined;
        if (text !== undefined && HAS_LETTER.test(text)) {
          report(node, `hard-coded text in ${attr} (U5): use a message`);
        }
      }
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      if (node.name.getText(sf) === "style") report(node, "style property (U4): use a tc-* class");
    }
    if (ts.isIdentifier(node)) {
      const banned = BANNED_IDENTIFIERS.get(node.text);
      if (banned) report(node, `${banned} is not allowed in the kit`);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sf) === "script") report(node, "<script> is not allowed (U3, U4)");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (calleeName === "eval") report(node, "eval( is not allowed");
      if (calleeName === "fetch") report(node, "fetch( is not allowed in the kit");
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const [arg] = node.arguments;
        const source = arg ? literalText(arg) : undefined;
        if (source === undefined) report(node, "import() with a source that is not a literal");
        else checkImport(node, source);
      }
      if (ts.isIdentifier(callee) && callee.text === "require") {
        report(node, "require( is not allowed in the kit");
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "Function") report(node, "new Function is not allowed");
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.getText(sf) === "document" && node.name.text === "cookie") {
        report(node, "document.cookie is not allowed in the kit");
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkImport(node, node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) checkImport(node, node.moduleSpecifier.text);
    }
    if (ts.isJsxText(node) && HAS_LETTER.test(node.text)) {
      report(node, `hard-coded text ${JSON.stringify(node.text.trim())} (U5): use a message`);
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const text = literalText(node.expression);
      if (text !== undefined && HAS_LETTER.test(text)) {
        report(node, `hard-coded text ${JSON.stringify(text)} (U5): use a message`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const componentFiles = readdirSync(here)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .sort();

describe("source rules of the kit components", () => {
  it.each(componentFiles)("%s follows the rules", (file) => {
    expect(checkSource(file, readFileSync(`${here}${file}`, "utf8"))).toEqual([]);
  });

  it('the set of files with "use client" equals CLIENT_COMPONENTS on disk', () => {
    const withDirective = componentFiles.filter((file) =>
      hasUseClient(readFileSync(`${here}${file}`, "utf8")),
    );
    const expected = CLIENT_COMPONENTS.map((name) => `${name}.tsx`)
      .filter((file) => componentFiles.includes(file))
      .sort();
    expect(withDirective).toEqual(expected);
  });
});

describe("checkSource (self-test of the rules)", () => {
  const wrap = (body: string): string => `export const A = () => (${body});`;
  const fires = (body: string, fragment: string): void => {
    const result = checkSource("Fixture.tsx", wrap(body));
    expect(
      result.some((line) => line.includes(fragment)),
      `${body} -> ${JSON.stringify(result)}`,
    ).toBe(true);
  };

  it("reports an inline style with its file and line", () => {
    const result = checkSource("Fixture.tsx", "export const A = () => <p style={{}}>Hello</p>;");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toMatch(/^Fixture\.tsx:1: inline style attribute/);
  });

  it("accepts a clean component", () => {
    const clean = [
      'import { useTranslations } from "next-intl";',
      'import { cx } from "./cx";',
      'import * as Dialog from "@radix-ui/react-dialog";',
      "export function A() {",
      '  const t = useTranslations("kit.common");',
      '  return <p className={cx("a", "b")} aria-label={t("close")} alt="">{t("close")}</p>;',
      "}",
    ].join("\n");
    expect(checkSource("Clean.tsx", clean)).toEqual([]);
  });

  it("reports the line of the violation", () => {
    const text = "export const A = () => (\n  <div>\n    <p style={{}} />\n  </div>\n);";
    expect(checkSource("Fixture.tsx", text)[0]).toMatch(/^Fixture\.tsx:3:/);
  });

  it("reports unsafe markup and code", () => {
    fires("<div dangerouslySetInnerHTML={{ __html: x }} />", "dangerouslySetInnerHTML");
    fires("<script />", "<script>");
    fires("<div ref={(e) => { e.innerHTML = x; }} />", "innerHTML");
    fires("eval(x)", "eval(");
    fires("new Function(x)", "new Function");
    fires("{ style: 1 }", "style property");
  });

  it("reports browser storage and network calls", () => {
    fires("localStorage.getItem(x)", "localStorage");
    fires("sessionStorage.getItem(x)", "sessionStorage");
    fires("document.cookie", "document.cookie");
    fires("fetch(x)", "fetch(");
    fires("window.fetch(x)", "fetch(");
    fires("new XMLHttpRequest()", "XMLHttpRequest");
    fires("navigator.sendBeacon(x)", "sendBeacon");
  });

  it("reports an import that is not on the list", () => {
    for (const source of ["next/link", "@tc/core", "lodash", "node:fs", "react-dom/client"]) {
      const result = checkSource("F.tsx", `import x from "${source}";`);
      expect(result.length, source).toBe(1);
    }
    expect(checkSource("F.tsx", 'export * from "next/link";').length).toBe(1);
    expect(checkSource("F.tsx", 'const m = import("next/link");').length).toBe(1);
    for (const source of ["react", "react-dom", "react-dom/server", "next-intl", "./x", "../y"]) {
      expect(checkSource("F.tsx", `import x from "${source}";`), source).toEqual([]);
    }
    expect(checkSource("F.tsx", 'import { x } from "@radix-ui/react-dialog";')).toEqual([]);
  });

  it("reports visible hard-coded text", () => {
    fires("<p>Hello</p>", "hard-coded text");
    fires("<p>বাংলা</p>", "hard-coded text");
    fires('<p>{"Hello"}</p>', "hard-coded text");
    fires("<p>{`Hello`}</p>", "hard-coded text");
    for (const attr of [
      "aria-label",
      "aria-description",
      "aria-valuetext",
      "title",
      "placeholder",
      "label",
    ]) {
      fires(`<input ${attr}="Name" />`, `hard-coded text in ${attr}`);
      fires(`<input ${attr}={"Name"} />`, `hard-coded text in ${attr}`);
    }
  });

  it("accepts text that is not a visible word", () => {
    const ok = [
      '<img alt="" src={x} />',
      "<p>{t(key)}</p>",
      "<p>{n}</p>",
      '<p>{" "}</p>',
      '<p>{"•"}</p>',
      '<p>{"12"}</p>',
      '<input aria-label={t("x")} />',
      '<span className="tc-x">{t("y")}</span>',
    ];
    for (const body of ok) {
      expect(checkSource("F.tsx", wrap(body)), body).toEqual([]);
    }
  });

  it('recognises the directive "use client" only at the start', () => {
    expect(hasUseClient('"use client";\nexport const A = 1;')).toBe(true);
    expect(hasUseClient("'use client'\nexport const A = 1;")).toBe(true);
    expect(hasUseClient('// c\n"use client";\nexport const A = 1;')).toBe(true);
    expect(hasUseClient('export const A = 1;\n"use client";')).toBe(false);
    expect(hasUseClient("export const A = 1;")).toBe(false);
  });
});
