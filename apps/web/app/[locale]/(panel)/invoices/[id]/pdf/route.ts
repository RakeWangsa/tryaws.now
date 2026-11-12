import { currentCustomer } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import {
  INVOICE_PDF_HEADERS,
  INVOICE_PDF_RATE_LIMITS,
  invoicePdf,
} from "../../../../../../server/invoice-pdf.ts";
import { getRuntime } from "../../../../../../server/runtime.ts";

// "Download PDF" of one of the customer's own invoices (WPU-N1). The runtime is started first (it
// configures sign-in and holds the renderer port); then the session is read (R9 step 1). The PDF is the
// answer of the invoice-renderer function, streamed as an attachment with Cache-Control private, no-store.
// When there is no PDF the route redirects to the invoice page with a fixed notice code, never with the
// text of an error (U6). The invoice is read for the session's customer inside invoicePdf (R8).
export const dynamic = "force-dynamic";

const plain = (status: number): Response =>
  new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(
  request: Request,
  context: { params: Promise<{ locale: string; id: string }> },
): Promise<Response> {
  const { locale, id } = await context.params;
  if (locale !== "bn" && locale !== "en") return plain(404);
  let runtime;
  let session;
  try {
    runtime = await getRuntime();
    const found = await currentCustomer();
    session = found.ok ? found.value : null;
  } catch {
    return plain(500);
  }
  const answer = await invoicePdf(
    {
      session,
      renderer: runtime.renderer,
      rateLimit: (s) =>
        withTx((tx) =>
          customerRepos(tx, s.customerId).rateLimits.consume(INVOICE_PDF_RATE_LIMITS, new Date()),
        ),
      customerName: (s) =>
        withTx(async (tx) => (await customerRepos(tx, s.customerId).profile.get())?.name ?? ""),
    },
    locale,
    id,
  );
  if (answer.status === 200) {
    return new Response(Buffer.from(answer.pdf), {
      status: 200,
      headers: {
        ...INVOICE_PDF_HEADERS,
        "Content-Disposition": `attachment; filename="${answer.filename}"`,
        "Content-Length": String(answer.pdf.byteLength),
      },
    });
  }
  if (answer.status === 303) {
    // Same origin by construction: a relative path built from the validated locale and id.
    const target = new URL(
      `/${locale}/invoices/${encodeURIComponent(id)}?pdf=${answer.notice}`,
      request.url,
    );
    return new Response(null, {
      status: 303,
      headers: { Location: target.pathname + target.search, "Cache-Control": "private, no-store" },
    });
  }
  return plain(answer.status);
}
