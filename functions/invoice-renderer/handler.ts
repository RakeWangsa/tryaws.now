// invoice-renderer (3, 9.3): turns the self-contained HTML of one invoice into a PDF and writes it to the
// invoices bucket. The caller (web or admin) has already done its own tenant check and builds the HTML
// with renderInvoiceHtml of @tc/core; this function has no database, no AWS provisioning and no network
// except the store (R1). It trusts nothing it is given: the ids, the locale and the HTML are checked, and
// HTML whose markup could fetch a resource or run code is refused (R16); the customer's text is checked by
// its escaping, not by a pattern (WPU-S8).
import { invoicePdfKey, type Locale, type Logger } from "@tc/core";

export const MAX_HTML_BYTES = 512 * 1024;

export interface PdfRenderer {
  render(html: string, opts: { locale: Locale }): Promise<Uint8Array>;
}
export interface PdfStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
}
export interface RendererDeps {
  readonly pdf: PdfRenderer;
  readonly store: PdfStore;
  readonly log: Logger;
}

export type RenderReport =
  { ok: true; key: string; bytes: number } | { ok: false; reason: "invalid_event" | "unsafe_html" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The safety check looks at the MARKUP of the page and not at the customer's text (WPU-S8, L3). Every value
// of the customer (name, address, tax number) is put into the page by escapeHtml of @tc/core, as a text
// node: it holds no "<" and cannot open a tag or an attribute. So the page is cut into three parts:
//  - the tags (with their attributes): no script, link, image, frame, object, embed, base, svg or math tag,
//    no src, href, style, form-action or on...= attribute, no URL scheme, no "//";
//  - the body of the style block: no URL, no @import, no url( and no CSS escape that could spell one;
//  - the text between them: free, except that it can hold no "<" (a "<" left over means a tag that did
//    not close, which is refused).
// The text can say "House 12//B", "Burl (East)", "on=1" or "https://shop.example": it is only text and the
// engine fetches nothing for it. Quoted attribute values are skipped as a unit, as a browser reads them, so
// a ">" inside quotes cannot end a tag early and hide an attribute behind it.
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const STYLE_BLOCK = /(<style\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style\s*>)/gi;
const UNSAFE_TAG =
  /^<\s*\/?\s*(script|link|img|iframe|frame|frameset|object|embed|applet|base|svg|math|form|input|button|audio|video|source|track|meta\s+http-equiv)\b|https?:|\/\/|\b(?:javascript|vbscript|data)\s*:|[\s/"'](?:on[a-z]+|src|srcset|href|xlink:href|style|action|formaction|poster|background|data)\s*=/i;
const UNSAFE_CSS = /https?:|\/\/|url\s*\(|@import|expression\s*\(|\\|<|javascript\s*:/i;

// Defence in depth against a parser differential (security review of WPU-S8): the pattern scanner above
// is not an HTML parser, so a tag is also accepted only if its NAME is on this list (the tags
// renderInvoiceHtml emits), and a dangerous tag name anywhere in the document is refused. Escaped
// customer text holds no "<", so neither rule can refuse ordinary text.
const ALLOWED_TAGS = new Set([
  "html",
  "head",
  "body",
  "title",
  "meta",
  "style",
  "div",
  "span",
  "p",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "h1",
  "h2",
  "h3",
  "header",
  "footer",
  "section",
  "strong",
  "b",
  "em",
  "i",
  "small",
  "br",
  "hr",
]);
const DANGEROUS_ANYWHERE =
  /<\s*\/?\s*(?:script|link|img|iframe|frame|frameset|object|embed|applet|base|svg|math|form|input|button|audio|video|source|track|template|noscript|xmp|plaintext)\b/i;
const META_CHARSET = /^<meta\s+charset\s*=\s*["']?utf-8["']?\s*\/?>$/i;
const DOCTYPE = /^<!doctype\s+html>$/i;

function tagAllowed(tag: string): boolean {
  if (DOCTYPE.test(tag)) return true;
  const m = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
  if (m === null) return false; // a comment, a processing instruction or a stray "<"
  const name = (m[1] ?? "").toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return false;
  if (name === "meta") return META_CHARSET.test(tag);
  return true;
}

function isSafeMarkup(html: string): boolean {
  if (DANGEROUS_ANYWHERE.test(html)) return false;
  let css = "";
  const withoutStyle = html.replace(STYLE_BLOCK, (_all, open: string, body: string) => {
    css += body + "\n";
    return open + "\u0000";
  });
  if (UNSAFE_CSS.test(css)) return false;
  for (const tag of withoutStyle.match(TAG) ?? []) {
    if (UNSAFE_TAG.test(tag) || !tagAllowed(tag)) return false;
  }
  const text = withoutStyle.replace(TAG, "");
  return !text.includes("<");
}

function parse(
  event: unknown,
): { customerId: string; invoiceId: string; locale: Locale; html: string } | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  const { customerId, invoiceId, locale, html } = e;
  if (typeof customerId !== "string" || !UUID.test(customerId)) return null;
  if (typeof invoiceId !== "string" || !UUID.test(invoiceId)) return null;
  if (locale !== "bn" && locale !== "en") return null;
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML_BYTES) return null;
  return { customerId, invoiceId, locale, html };
}

// Logs fixed reasons only: no id, no number, no customer text, no HTML (R14). A failure of the engine or
// of the store throws a fixed message, so the invocation fails visibly and can be retried: the key is
// derived, so a retry overwrites the same object.
export function createInvoiceRendererHandler(
  deps: RendererDeps,
): (event: unknown) => Promise<RenderReport> {
  return async (event) => {
    const input = parse(event);
    if (input === null) {
      deps.log({ event: "invoice_render_refused", reason: "invalid_event" });
      return { ok: false, reason: "invalid_event" };
    }
    if (!isSafeMarkup(input.html)) {
      deps.log({ event: "invoice_render_refused", reason: "unsafe_html" });
      return { ok: false, reason: "unsafe_html" };
    }
    let bytes: Uint8Array;
    try {
      bytes = await deps.pdf.render(input.html, { locale: input.locale });
    } catch {
      deps.log({ event: "invoice_render_failed", reason: "render_threw" });
      throw new Error("invoice-renderer: render failed");
    }
    const key = invoicePdfKey(input.customerId, input.invoiceId, input.locale);
    try {
      await deps.store.put(key, bytes);
    } catch {
      deps.log({ event: "invoice_render_failed", reason: "store_threw" });
      throw new Error("invoice-renderer: store failed");
    }
    deps.log({ event: "invoice_rendered", locale: input.locale, bytes: bytes.byteLength });
    return { ok: true, key, bytes: bytes.byteLength };
  };
}
