import { describe, expect, it, vi } from "vitest";

// WPU-G4: the printable invoice. Cross-tenant proof for the route (R8), the headers, the fail-closed
// answers (R16).

const state = vi.hoisted(() => ({
  rows: [] as { id: string; customerId: string; lines: unknown; totalMinor: bigint }[],
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => ({
    invoices: {
      get: async (id: string) => {
        const found = state.rows.find((r) => r.id === id && r.customerId === customerId);
        return found === undefined
          ? null
          : {
              ...found,
              fiscalYear: 2026,
              number: 12,
              orderId: null,
              issuedAt: new Date("2026-11-01T06:00:00Z"),
              pdfKey: null,
            };
      },
    },
  }),
}));

const { INVOICE_DOCUMENT_HEADERS, invoiceDocument } = await import("./invoice-document.ts");

const A = "0190aaaa-0000-7000-8000-0000000000c1";
const B = "0190aaaa-0000-7000-8000-0000000000c2";
const INV = "0190aaaa-0000-7000-8000-0000000000e1";
const LINES = [
  {
    kind: "service",
    code: "aws",
    label: { bn: "এডব্লিউএস", en: "AWS service" },
    amountMinor: "60000",
  },
  { kind: "step", code: "vat", label: { bn: "ভ্যাট", en: "VAT <b>" }, amountMinor: "9000" },
];
const deps = (customerId: string | null, name = "Rahim") => ({
  session: customerId === null ? null : ({ customerId } as never),
  customerName: async () => name,
});

describe("the printable invoice", () => {
  it("answers 401 without a session and reads nothing (R9)", async () => {
    state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 69000n }];
    expect(await invoiceDocument(deps(null), "en", INV)).toEqual({ status: 401 });
  });

  it("prints the invoice of the session's customer: number, lines, total, escaped text", async () => {
    state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 69000n }];
    const out = await invoiceDocument(deps(A, "Rahim <script>"), "en", INV);
    expect(out.status).toBe(200);
    const html = out.html as string;
    expect(html).toContain("TC-2026-000012");
    expect(html).toContain("690.00");
    expect(html).toContain("AWS service");
    expect(html).toContain("VAT &lt;b&gt;");
    expect(html).toContain("Rahim &lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain("100% AWS infrastructure");
  });

  it("is in Bengali with Bengali digits in bn", async () => {
    state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 69000n }];
    const out = await invoiceDocument(deps(A), "bn", INV);
    expect(out.html).toContain("৬৯০.০০");
    expect(out.html).toContain("ইনভয়েস");
  });

  it("answers 404 for another customer's invoice, like for a missing one (R8)", async () => {
    state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 69000n }];
    expect(await invoiceDocument(deps(B), "en", INV)).toEqual({ status: 404 });
    expect(await invoiceDocument(deps(A), "en", "0190aaaa-0000-7000-8000-0000000000ff")).toEqual({
      status: 404,
    });
    expect(await invoiceDocument(deps(A), "en", "../../x")).toEqual({ status: 404 });
  });

  it("refuses lines that do not add up instead of printing a wrong total (R16)", async () => {
    state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 70000n }];
    expect(await invoiceDocument(deps(A), "en", INV)).toEqual({ status: 500 });
  });

  it("fails closed when the name cannot be read", async () => {
    state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 69000n }];
    const out = await invoiceDocument(
      {
        session: { customerId: A } as never,
        customerName: async () => {
          throw new Error("db down arn:aws:rds:x");
        },
      },
      "en",
      INV,
    );
    expect(out).toEqual({ status: 500 });
  });

  it("carries a CSP that allows nothing but its inline CSS, and is never cached", () => {
    const csp = INVOICE_DOCUMENT_HEADERS["Content-Security-Policy"] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src|https?:/);
    expect(INVOICE_DOCUMENT_HEADERS["Cache-Control"]).toBe("private, no-store");
    expect(INVOICE_DOCUMENT_HEADERS["X-Robots-Tag"]).toContain("noindex");
  });
});
