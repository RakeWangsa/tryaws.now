import type { CustomerSession } from "@tc/auth";
import { renderInvoiceHtml } from "@tc/core";
import type { Locale } from "@tc/core";
import { loadInvoice, toInvoiceDocument } from "./invoice-view.ts";

// The printable invoice (WPU-G4): the same HTML that invoice-renderer turns into the PDF
// (renderInvoiceHtml of @tc/core), served to its owner so that the browser can print it or save it as a
// PDF. R8: the invoice is read for the session's customer; another customer's id answers like a missing
// one. R16: lines that do not add up are not printed. The document refers to no URL and runs no script;
// its own response headers say so (the CSP below), because it carries inline CSS (U4 exception for the
// invoice HTML). Nothing of an error leaves this file (U6).

export const INVOICE_DOCUMENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
});

// R9: the printable page is a render of the stored snapshots on each click; sixty a minute for each
// customer is far above a person printing and stops a script from using it as a read loop.
export const INVOICE_DOCUMENT_RATE_LIMITS = Object.freeze([
  Object.freeze({ action: "invoice.document", limit: 60, windowSeconds: 60 }),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DocumentDeps {
  /** The session of the request, or null (R9 step 1). */
  session: CustomerSession | null;
  /** The name of the customer for "Billed to"; empty when none. */
  customerName(session: CustomerSession): Promise<string>;
}

export type DocumentAnswer =
  { status: 200; html: string } | { status: 401 | 404 | 500 | 503; html?: undefined };

export interface PrintDeps extends DocumentDeps {
  rateLimit(session: CustomerSession): Promise<{ allowed: boolean }>;
}

export type PrintAnswer = DocumentAnswer | { status: 429; html?: undefined };

/**
 * The answer of the printable-invoice route, in the order of R9: the session (401), the id (404), the
 * rate limit (429; a limiter that cannot answer is 503, R16), then the invoice read for the session's
 * customer. The PDF route does its own limiting and calls `invoiceDocument` below, so a render is not
 * counted twice.
 */
export async function printableInvoice(
  deps: PrintDeps,
  locale: Locale,
  id: string,
): Promise<PrintAnswer> {
  const session = deps.session;
  if (session === null) return { status: 401 };
  if (!UUID.test(id)) return { status: 404 };
  try {
    if (!(await deps.rateLimit(session)).allowed) return { status: 429 };
  } catch {
    return { status: 503 };
  }
  return invoiceDocument(deps, locale, id);
}

export async function invoiceDocument(
  deps: DocumentDeps,
  locale: Locale,
  id: string,
): Promise<DocumentAnswer> {
  const session = deps.session;
  if (session === null) return { status: 401 };
  try {
    const screen = await loadInvoice(session, id);
    if (screen === null) return { status: 404 };
    // No seller details, no tax invoice (R16, WPU-I1): 503, not a half-filled document.
    if (screen.state === "seller_missing") return { status: 503 };
    if (screen.state !== "ready") return { status: 500 };
    const name = await deps.customerName(session);
    const numerals = locale === "bn" ? "beng" : "latn";
    return {
      status: 200,
      html: renderInvoiceHtml(
        toInvoiceDocument(screen.invoice, name, numerals, screen.seller, screen.buyer),
        locale,
      ),
    };
  } catch {
    return { status: 500 };
  }
}
