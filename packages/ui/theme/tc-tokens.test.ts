import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");
const tc = read("packages/ui/styles/tc.css");
const themeCss = read("design/mockup/template/assets/css/theme.min.css");
const bootstrapCss = read("design/mockup/template/assets/css/bootstrap.min.css");

/** The last declaration of `prop` in a rule whose selector list holds `selector` exactly. */
function declaration(css: string, selector: string, prop: string) {
  let found: { value: string; important: boolean } | undefined;
  parse(css).walkRules((rule) => {
    if (!rule.selectors.map((s) => s.replace(/\s+/g, " ").trim()).includes(selector)) return;
    rule.walkDecls(prop, (d) => {
      found = { value: d.value, important: d.important === true };
    });
  });
  return found;
}
const hex6 = (value: string | undefined): string | undefined => {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value ?? "");
  return (m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : value)?.toLowerCase();
};

describe("tokens (16.4): the values of the theme itself", () => {
  const dark = 'body[data-background="dark"]';
  const light = 'body[data-background="light"]';
  const pink = 'body[data-color="pink"]';
  const blue = 'body[data-color="blue"]';
  it.each([
    [
      dark,
      "--tc-page",
      themeCss,
      "[data-background=dark] .box-container .bg-colorstyle",
      "background-color",
    ],
    [
      dark,
      "--tc-card",
      themeCss,
      "[data-background=dark] .box-container .bg-seccolorstyle",
      "background-color",
    ],
    [dark, "--tc-text", themeCss, "[data-background=dark] .box-container .mergecolor", "color"],
    [
      light,
      "--tc-page",
      themeCss,
      "[data-background=light] .box-container .bg-colorstyle",
      "background-color",
    ],
    [
      light,
      "--tc-card",
      themeCss,
      "[data-background=light] .box-container .bg-seccolorstyle",
      "background-color",
    ],
    [light, "--tc-text", themeCss, "[data-background=light] .box-container .mergecolor", "color"],
    [pink, "--tc-accent", themeCss, "[data-color=pink] .bg-pink", "background-color"],
    [pink, "--tc-accent-2", themeCss, "[data-color=pink] .bg-purple", "background-color"],
    [blue, "--tc-accent", themeCss, "[data-color=blue] .bg-pink", "background-color"],
    [blue, "--tc-accent-2", themeCss, "[data-color=blue] .bg-purple", "background-color"],
    [":root", "--tc-yellow", themeCss, ".btn-default-yellow-fill", "background-color"],
    [":root", "--tc-muted", bootstrapCss, ".text-muted", "color"],
    [":root", "--tc-radius-card", themeCss, ".sec-main", "border-radius"],
    [":root", "--tc-radius-plan", themeCss, ".pricing .wrapper", "border-radius"],
  ])("%s %s is what the theme sets (%s)", (selector, token, css, themeSelector, prop) => {
    const mine = declaration(tc, selector, token)?.value;
    expect(mine, `${selector} ${token}`).toBeDefined();
    expect(hex6(mine)).toBe(hex6(declaration(css, themeSelector, prop)?.value));
  });

  it("has the focus colors that the two backgrounds need: yellow on dark, the text color on light", () => {
    expect(declaration(tc, dark, "--tc-focus")?.value).toBe("#fdd700");
    expect(declaration(tc, light, "--tc-focus")?.value).toBe(
      declaration(tc, light, "--tc-text")?.value,
    );
  });

  it("the values are those that 16.4 names", () => {
    const value = (selector: string, token: string): string | undefined =>
      hex6(declaration(tc, selector, token)?.value);
    expect([value(dark, "--tc-page"), value(dark, "--tc-card"), value(dark, "--tc-text")]).toEqual([
      "#15212a",
      "#101920",
      "#ffffff",
    ]);
    expect([
      value(light, "--tc-page"),
      value(light, "--tc-card"),
      value(light, "--tc-text"),
    ]).toEqual(["#ffffff", "#ebeff5", "#212122"]);
    expect([
      value(pink, "--tc-accent"),
      value(pink, "--tc-accent-2"),
      value(":root", "--tc-yellow"),
      value(":root", "--tc-muted"),
    ]).toEqual(["#ee5586", "#a5215e", "#fdd700", "#6c757d"]);
    expect([value(":root", "--tc-radius-card"), value(":root", "--tc-radius-plan")]).toEqual([
      "12px",
      "15px",
    ]);
  });
});

/** Specificity [ids, classes, elements] of one selector. An approximation that over-counts :is(); good enough for the test below. */
function specificity(selector: string): [number, number, number] {
  const text = selector.replace(/"[^"]*"|'[^']*'/g, "");
  const ids = (text.match(/#[\w-]+/g) ?? []).length;
  const classes = (text.match(/\.[\w-]+|\[[^\]]*\]|:(?!:|where\b|is\b|not\b|has\b)[\w-]+/g) ?? [])
    .length;
  const elements = (
    text.replace(/\[[^\]]*\]/g, "").match(/(?:^|[\s>+~(,])[a-z][\w-]*|::[\w-]+/gi) ?? []
  ).length;
  return [ids, classes, elements];
}
const above = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

describe("Bengali typography (16.4)", () => {
  it("sets a line height of at least 1.6, no letter-spacing and no text-transform under html[lang=bn]", () => {
    expect(
      Number(declaration(tc, 'html[lang="bn"] body', "line-height")?.value),
    ).toBeGreaterThanOrEqual(1.6);
    expect(declaration(tc, 'html[lang="bn"] *', "letter-spacing")).toEqual({
      value: "0",
      important: true,
    });
    expect(declaration(tc, 'html[lang="bn"] *', "text-transform")).toEqual({
      value: "none",
      important: true,
    });
    expect(declaration(tc, 'html[lang="bn"] *::before', "letter-spacing")?.value).toBe("0");
  });

  it("wins against every !important letter-spacing or text-transform of the theme that html[lang=bn] * cannot beat", () => {
    // html[lang="bn"] * is (0,1,1). The theme's `.btn.question { letter-spacing:1px !important; text-transform:uppercase
    // !important }` is (0,2,0) and would win; tc.css repeats that selector behind html[lang="bn"].
    const hard = new Set<string>();
    parse(themeCss).walkDecls(/^(letter-spacing|text-transform)$/, (d) => {
      const rule = d.parent as Rule | undefined;
      if (!d.important || d.value === "0" || d.value === "none" || rule?.type !== "rule") return;
      for (const selector of rule.selectors)
        if (above(specificity(selector), [0, 1, 1])) hard.add(selector.replace(/\s+/g, " ").trim());
    });
    expect([...hard].sort()).toEqual([".btn.question"]); // measured on 2026-11-11 (Antler 4.5.0)
    for (const selector of hard) {
      expect(declaration(tc, `html[lang="bn"] ${selector}`, "letter-spacing"), selector).toEqual({
        value: "0",
        important: true,
      });
      expect(declaration(tc, `html[lang="bn"] ${selector}`, "text-transform"), selector).toEqual({
        value: "none",
        important: true,
      });
    }
  });

  it("is needed: the theme sets a letter spacing on the body and capitals on some elements", () => {
    expect(declaration(themeCss, "body", "letter-spacing")?.value).toBe(".3px");
    expect(themeCss).toContain("text-transform:uppercase");
  });
});

describe("keyboard focus", () => {
  it("Review Focus 3: the theme removes the outline with !important, and tc.css puts a ring back with !important", () => {
    expect(declaration(themeCss, "a", "outline")).toEqual({ value: "0", important: true });
    expect(declaration(themeCss, ".btn:focus", "outline")).toEqual({
      value: "0",
      important: true,
    });
    // Later tasks may add rules, also with :focus-visible. This finds the rule of section 3 by its :is() list and keeps the first.
    let rule: { selector: string; outline: string; important: boolean } | undefined;
    parse(tc).walkRules((r) => {
      const selector = r.selector.replace(/\s+/g, "");
      if (
        rule !== undefined ||
        !selector.includes(":is(a,") ||
        !selector.includes(":focus-visible")
      )
        return;
      r.walkDecls("outline", (d) => {
        rule = { selector, outline: d.value, important: d.important === true };
      });
    });
    expect(rule?.important).toBe(true);
    expect(rule?.outline).toBe("3px solid var(--tc-focus)");
    for (const element of [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      ".btn",
      ".form-control",
      ".form-select",
    ])
      expect(rule?.selector, element).toMatch(new RegExp(`[(,]${element.replace(".", "\\.")}[,)]`));
  });
});

describe("what tc.css may contain (U1, U3, U4)", () => {
  it("defines only classes that start with tc-: the subject of every rule is a tc- class (U1)", () => {
    // The rules that override a defect of the theme name theme classes (section 3: .btn, .form-control and .form-select
    // inside :is(); section 4: .btn.question behind html[lang=bn]). They are found by :focus-visible and html[lang= and
    // have their own tests. Later tasks (sections 5 to 7) add tc- rules and may name theme classes in the ancestors.
    const classes = new Set<string>();
    parse(tc).walkRules((rule) => {
      if (rule.selector.includes(":focus-visible") || rule.selector.includes("html[lang=")) return;
      for (const selector of rule.selectors) {
        const subject =
          selector
            .trim()
            .split(/\s*[>+~]\s*|\s+/)
            .pop() ?? "";
        for (const m of subject.matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(m[1] ?? "");
      }
    });
    expect([...classes].filter((c) => !c.startsWith("tc-")).sort()).toEqual([]);
  });

  it("defines only custom properties that start with --tc-", () => {
    const names: string[] = [];
    parse(tc).walkDecls((d) => {
      if (d.prop.startsWith("--")) names.push(d.prop);
    });
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => !n.startsWith("--tc-"))).toEqual([]);
  });

  it("holds no @import rule and no expression()", () => {
    const imports: string[] = [];
    const expressions: string[] = [];
    parse(tc).walk((node) => {
      if (node.type === "atrule" && node.name === "import") imports.push(node.params);
      if (node.type === "decl" && /expression\(/i.test(node.value)) expressions.push(node.prop);
    });
    expect([imports, expressions]).toEqual([[], []]);
  });
});
