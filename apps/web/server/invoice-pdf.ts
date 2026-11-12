import type { CustomerSession } from "@tc/auth";
import type { Locale } from "@tc/core";
import { invoiceDocument, type DocumentDeps } from "./invoice-document.ts";
import type { RendererPort } from "./renderer-invoke.ts";

// "Download PDF" of one of the customer's own invoices (WPU-N1). Order of R9: the session (401), the rate
// limit, the invoice read for the session's customer (R8: another customer's id is a 404), the HTML of
// the stored snapshots (the same renderInvoiceHtml as the printable page), then the renderer. The
// session's customer id, never a request field, goes to the renderer. R16: a missing renderer, a refused
// or failed render and an invoice that cannot be printed all end without a PDF. Nothing of an error
// leaves this file (U6).

export const INVOICE_PDF_RATE_LIMITS = Object.freeze([
  // A render starts a browser: ten a minute per customer is far above a person clicking.
  Object.freeze({ action: "invoice.pdf", limit: 10, windowSeconds: 60 }),
]);

export const INVOICE_PDF_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/pdf",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PdfDeps extends DocumentDeps {
  /** null = no renderer configured. */
  renderer: RendererPort | null;
  rateLimit(session: CustomerSession): Promise<{ allowed: boolean }>;
}

/** What the page shows when there is no PDF; the route redirects to the page with one of these. */
export type PdfNotice = "unavailable" | "not_ready" | "busy";

export type PdfAnswer =
  | { status: 200; pdf: Uint8Array; filename: string }
  | { status: 401 | 404 }
  | { status: 303; notice: PdfNotice };

export async function invoicePdf(deps: PdfDeps, locale: Locale, id: string): Promise<PdfAnswer> {
  const session = deps.session;
  if (session === null) return { status: 401 };
  if (!UUID.test(id)) return { status: 404 };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { status: 303, notice: "unavailable" };
  }
  if (!allowed) return { status: 303, notice: "busy" };
  const doc = await invoiceDocument(deps, locale, id);
  if (doc.status === 404) return { status: 404 };
  if (doc.status === 401) return { status: 401 };
  if (doc.status !== 200) return { status: 303, notice: "unavailable" };
  if (deps.renderer === null) return { status: 303, notice: "unavailable" };
  try {
    const out = await deps.renderer.render({
      customerId: session.customerId,
      invoiceId: id,
      locale,
      html: doc.html,
    });
    if (!out.ok) {
      return { status: 303, notice: out.error === "not_ready" ? "not_ready" : "unavailable" };
    }
    return { status: 200, pdf: out.pdf, filename: `invoice-${id}.pdf` };
  } catch {
    return { status: 303, notice: "unavailable" };
  }
}
