import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "../components/types";
import { THEME_ABSENT, vendoredThemePresent } from "../theme/present.ts";
import { knownClasses } from "./class-inventory";

// Not `new URL("../messages/", import.meta.url)`: in a jsdom test Vite rewrites that form to an http URL.
const messagesRoot = `${dirname(dirname(fileURLToPath(import.meta.url)))}/messages/`;
const TIME_ZONE = "Asia/Dhaka";

type Tree = { [key: string]: unknown };
const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep merge of `source` into `target`; a leaf that exists twice with another value is a defect. */
function merge(target: Tree, source: Tree, path: string): void {
  for (const [key, value] of Object.entries(source)) {
    const here = path === "" ? key : `${path}.${key}`;
    const existing = target[key];
    if (isTree(value) && isTree(existing)) merge(existing, value, here);
    else if (existing !== undefined) throw new Error(`messages: ${here} is defined twice`);
    else target[key] = value;
  }
}

/**
 * Every `messages/<locale>/*.json` found on disk, merged deep. Each file holds
 * `{ "kit": { "<group>": { ... } } }`, so the result is one tree under `kit`.
 */
export function kitMessages(locale: Locale): Record<string, unknown> {
  const dir = `${messagesRoot}${locale}/`;
  const merged: Tree = {};
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    merge(merged, JSON.parse(readFileSync(`${dir}${file}`, "utf8")) as Tree, "");
  }
  return merged;
}

function inProvider(ui: ReactElement, locale: Locale): ReactElement {
  return (
    <NextIntlClientProvider locale={locale} messages={kitMessages(locale)} timeZone={TIME_ZONE}>
      {ui}
    </NextIntlClientProvider>
  );
}

/** Renders `ui` in jsdom with the kit messages. The default locale is bn (Bengali first). */
export function renderKit(ui: ReactElement, opts: { locale?: Locale } = {}): RenderResult {
  return render(inProvider(ui, opts.locale ?? "bn"));
}

/** The server-rendered markup of `ui` in the same provider, without a document. */
export function ssr(ui: ReactElement, opts: { locale?: Locale } = {}): string {
  return renderToStaticMarkup(inProvider(ui, opts.locale ?? "bn"));
}

let announced = false;

/**
 * The classes in `root` (an element tree, or an HTML string) that no stylesheet of the kit defines.
 * Each class appears once, in order of first use.
 *
 * Without the paid Antler theme (a public checkout, docs/theme.md) there is no stylesheet to check
 * against, and this returns [] so that the other assertions of the same test still run. That is the
 * one check a public checkout does not make, so it says so once per test file on stderr. A test whose
 * whole point is the class inventory uses knownClasses(), which throws, behind vendoredThemePresent().
 */
export function unknownClasses(root: Element | string): string[] {
  if (!vendoredThemePresent()) {
    if (!announced) {
      announced = true;
      process.stderr.write(`unknownClasses: not evaluated, ${THEME_ABSENT}\n`);
    }
    return [];
  }
  const values: string[] = [];
  if (typeof root === "string") {
    for (const match of root.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      values.push(match[1] ?? match[2] ?? "");
    }
  } else {
    for (const el of [root, ...root.querySelectorAll("[class]")]) {
      values.push(el.getAttribute("class") ?? "");
    }
  }
  const known = knownClasses();
  const unknown = new Set<string>();
  for (const value of values) {
    for (const name of value.split(/\s+/)) {
      if (name !== "" && !known.has(name)) unknown.add(name);
    }
  }
  return [...unknown];
}
