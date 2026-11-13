import { currentCustomer } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import {
  INVOICE_DOCUMENT_HEADERS,
  INVOICE_DOCUMENT_RATE_LIMITS,
  printableInvoice,
} from "../../../../../../server/invoice-document.ts";
import { getRuntime } from "../../../../../../server/runtime.ts";

// The printable invoice of one of the customer's own invoices (WPU-G4): the same HTML as the PDF. The
// runtime is started first (it configures sign-in); then the session is read (R9 step 1), the id is
// checked and the customer's rate limit is consumed before the invoice is read. The answers are fixed
// and carry no text of an error (U6).
export const dynamic = "force-dynamic";

const plain = (status: number): Response =>
  new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; id: string }> },
): Promise<Response> {
  const { locale, id } = await context.params;
  if (locale !== "bn" && locale !== "en") return plain(404);
  let session;
  try {
    await getRuntime();
    const found = await currentCustomer();
    session = found.ok ? found.value : null;
  } catch {
    return plain(500);
  }
  const answer = await printableInvoice(
    {
      session,
      rateLimit: (s) =>
        withTx((tx) =>
          customerRepos(tx, s.customerId).rateLimits.consume(
            INVOICE_DOCUMENT_RATE_LIMITS,
            new Date(),
          ),
        ),
      customerName: (s) =>
        withTx(async (tx) => (await customerRepos(tx, s.customerId).profile.get())?.name ?? ""),
    },
    locale,
    id,
  );
  if (answer.status !== 200) return plain(answer.status);
  return new Response(answer.html, { status: 200, headers: { ...INVOICE_DOCUMENT_HEADERS } });
}
