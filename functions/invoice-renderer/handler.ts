// invoice-renderer (3, 9.3): turns the self-contained HTML of one invoice into a PDF and writes it to the
// invoices bucket. The caller (web or admin) has already done its own tenant check and builds the HTML
// with renderInvoiceHtml of @tc/core; this function has no database, no AWS provisioning and no network
// except the store (R1). It trusts nothing it is given: the ids, the locale and the HTML are checked, and
// HTML that could fetch a resource or run code is refused (R16).
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
// The template refers to no URL, loads nothing and has no script or style attribute.
const UNSAFE =
  /https?:|\/\/|url\s*\(|@import|<\s*(script|link|img|iframe|object|embed|base)\b|\bsrc\s*=|\bstyle\s*=|\bon[a-z]+\s*=/i;

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
    if (UNSAFE.test(input.html)) {
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
