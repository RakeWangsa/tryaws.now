import type { Locale } from "@tc/core";
import type { Numerals } from "../sms/otp-text";
import { digits, fill, formatDhakaDate, formatMoney } from "../text/format";
import { NotifyError, TEMPLATE_IDS, type Channel, type TemplateId } from "../queue/types";
import { parseData, type Parsed } from "./data";
import { DEFS, type Helpers } from "./defs";
import { layoutEmail, panelUrl } from "./layout";
import { notifyLocale } from "./locale";
import { BN, EN, SHARED } from "./messages";

export interface RenderContext {
  readonly locale: Locale;
  readonly numerals: Numerals;
  readonly panelOrigin: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}
export interface RenderedInApp {
  readonly title: string;
  readonly body: string;
  readonly href: string;
}

export const isTemplateId = (v: unknown): v is TemplateId =>
  typeof v === "string" && (TEMPLATE_IDS as readonly string[]).includes(v);

// Parses with the closed list of the template: this is the one door for data, at queue time and
// again at send time (a stored payload from an older version is checked, not trusted).
export function parseTemplateData(id: TemplateId, data: unknown): Record<string, Parsed> {
  return parseData(DEFS[id].spec, data);
}

export function channelsOf(
  id: TemplateId,
  data: Readonly<Record<string, Parsed>>,
): readonly Channel[] {
  return DEFS[id].channels(data);
}

// A placeholder the catalog string names gets its value from `vars`; only those are passed on, so
// fill() can stay strict about a placeholder without a value.
function fillFrom(text: string, vars: Readonly<Record<string, string>>): string {
  const names = new Set(
    [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1] as string),
  );
  const used: Record<string, string> = {};
  for (const n of names) {
    if (!Object.hasOwn(vars, n)) throw new TypeError("render: a placeholder has no value");
    used[n] = vars[n] as string;
  }
  return fill(text, used);
}

function build(id: TemplateId, data: Readonly<Record<string, Parsed>>, given: RenderContext) {
  const ctx: RenderContext = { ...given, locale: notifyLocale(given.locale) };
  if (!isTemplateId(id)) throw new NotifyError("unknown_template");
  const def = DEFS[id];
  const text = (ctx.locale === "bn" ? BN : EN)[id];
  const shared = SHARED[ctx.locale];
  const dig = (s: string) => digits(s, ctx.locale, ctx.numerals);
  const h: Helpers = {
    m: (v) => formatMoney(String(v), ctx.locale, ctx.numerals),
    d: (v) => formatDhakaDate(String(v), ctx.locale, ctx.numerals),
    n: (v) => dig(String(v)),
    product: (v) => shared.products[String(v)] ?? String(v),
    region: (v) => shared.regions[String(v)] ?? String(v),
    x: (key, vars = {}) => {
      const sentence = text.extra?.[key];
      if (sentence === undefined) throw new TypeError("render: unknown extra sentence");
      return fillFrom(sentence, vars);
    },
  };
  const vars = def.vars(data, h);
  return { def, text, shared, vars, href: panelUrl(ctx.panelOrigin, ctx.locale, def.path(data)) };
}

export function renderEmail(
  id: TemplateId,
  data: Readonly<Record<string, Parsed>>,
  ctx: RenderContext,
): RenderedEmail {
  const { def, text, shared, vars, href } = build(id, data, ctx);
  const subject = fillFrom(text.subject, vars);
  const cta = typeof def.cta === "function" ? def.cta(data) : def.cta;
  const label = shared.cta[cta];
  if (label === undefined) throw new TypeError("render: the button has no label");
  const { html, text: plain } = layoutEmail({
    locale: notifyLocale(ctx.locale),
    subject,
    headline: fillFrom(text.headline, vars),
    // A paragraph that is empty for this data (for example the reply text of a mail that only links to
    // it) is left out by the layout.
    paragraphs: text.body.map((p) => fillFrom(p, vars)),
    button: { label, url: href },
  });
  return { subject, html, text: plain };
}

// Null when the template has no SMS for this data (for example a reminder at 7 days).
export function renderSms(
  id: TemplateId,
  data: Readonly<Record<string, Parsed>>,
  ctx: RenderContext,
): string | null {
  const { text, vars } = build(id, data, ctx);
  if (!DEFS[id].channels(data).includes("sms")) return null;
  if (text.sms === undefined) throw new TypeError("render: the template has no SMS text");
  return fillFrom(text.sms, vars);
}

// The bell item: rendered when it is shown, in the viewer's locale.
export function renderInApp(
  id: TemplateId,
  data: Readonly<Record<string, Parsed>>,
  ctx: RenderContext,
): RenderedInApp {
  const { text, vars, href } = build(id, data, ctx);
  return {
    title: fillFrom(text.headline, vars),
    body: text.body
      .map((p) => fillFrom(p, vars))
      .filter((p) => p.length > 0)
      .join(" ")
      .replace(/\s*\n\s*/g, " "),
    href,
  };
}
