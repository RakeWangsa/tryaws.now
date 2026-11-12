import { describe, expect, it, vi } from "vitest";

// WPU-C1: /invoices lists the credit notes of the session's customer, /invoices/[id] and its document render
// them (R8 tenant scoping, R16 fail closed), and the document of an invoice prints the date of supply.

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@tc/db", async () => ({
  parseSellerRowValue: (await vi.importActual<typeof import("@tc/db")>("@tc/db"))
    .parseSellerRowValue,
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => ({
    profile: { get: async () => ({ id: customerId, market: "BD", name: "Rahim" }) },
    invoices: {
      list: async () => ({
        items: state.rows.filter((r) => r["customerId"] === customerId),
        next: null,
      }),
      get: async (id: string) =>
        state.rows.find((r) => r["id"] === id && r["customerId"] === customerId) ?? null,
    },
  }),
}));

const { loadInvoice, loadInvoiceList, parseInvoiceCursor, formatInvoiceCursor } =
  await import("./invoice-view.ts");
const { invoiceDocument } = await import("./invoice-document.ts");

const A = "0190aaaa-0000-7000-8000-0000000000c1";
const B = "0190aaaa-0000-7000-8000-0000000000c2";
const INV = "0190aaaa-0000-7000-8000-0000000000e1";
const CN = "0190aaaa-0000-7000-8000-0000000000e3";
const SELLER = {
  v: 1,
  version: 1,
  legalNameBn: "ক",
  legalNameEn: "Seller Ltd",
  bin: "0000000000000",
  addressBn: "ক",
  addressEn: "Dhaka",
  signatoryName: "A",
  signatoryDesignation: "B",
};
const LINES = [
  {
    kind: "service",
    code: "aws",
    label: { bn: "এডব্লিউএস", en: "AWS service" },
    amountMinor: "60000",
  },
  {
    kind: "step",
    code: "bd_vat",
    label: { bn: "ভ্যাট", en: "VAT" },
    amountMinor: "3000",
    rate: "0.05",
  },
];
const base = {
  customerId: A,
  fiscalYear: 2026,
  orderId: null,
  lines: LINES,
  totalMinor: 63000n,
  pdfKey: null,
  seller: SELLER,
  buyer: { name: "Rahim Buyer", address: "Mirpur", taxId: null },
  reason: null,
  originalInvoiceId: null,
};
const invoice = {
  ...base,
  id: INV,
  number: 12,
  kind: "invoice",
  issuedAt: new Date("2026-11-14T06:00:00Z"),
  supplyAt: new Date("2026-11-11T06:00:00Z"),
};
const creditNote = {
  ...base,
  id: CN,
  number: 1,
  kind: "credit_note",
  issuedAt: new Date("2026-11-20T06:00:00Z"),
  supplyAt: null,
  reason: "order_failed",
  originalInvoiceId: INV,
};
const session = (customerId: string) => ({ customerId }) as never;
const deps = (customerId: string | null) => ({
  session: customerId === null ? null : session(customerId),
  customerName: async () => "Rahim",
});

describe("the cursor knows the credit note sequence", () => {
  it("round-trips an invoice and a credit note key and refuses the rest", () => {
    expect(parseInvoiceCursor("2026-cn-3")).toEqual({
      fiscalYear: 2026,
      number: 3,
      kind: "credit_note",
    });
    expect(parseInvoiceCursor("2026-3")).toEqual({ fiscalYear: 2026, number: 3 });
    expect(formatInvoiceCursor({ fiscalYear: 2026, number: 3, kind: "credit_note" })).toBe(
      "2026-cn-3",
    );
    expect(formatInvoiceCursor({ fiscalYear: 2026, number: 3, kind: "invoice" })).toBe("2026-3");
    for (const bad of ["2026-cn-", "2026-xx-3", "2026-cn-0", "2026-cn-cn-1", "cn-2026-1"]) {
      expect(parseInvoiceCursor(bad), bad).toBeNull();
    }
  });
});

describe("/invoices", () => {
  it("lists a credit note with its own number form and kind, to its owner only (R8)", async () => {
    state.rows = [
      invoice,
      creditNote,
      { ...creditNote, id: "0190aaaa-0000-7000-8000-0000000000e4", customerId: B },
    ];
    const mine = await loadInvoiceList(session(A), undefined);
    expect(mine.state).toBe("ready");
    if (mine.state === "ready") {
      expect(mine.items.map((i) => [i.number, i.kind])).toEqual([
        ["TC-2026-000012", "invoice"],
        ["TC-CN-2026-000001", "credit_note"],
      ]);
    }
  });
});

describe("/invoices/[id] for a credit note", () => {
  it("names the original invoice (number and date) and the reason", async () => {
    state.rows = [invoice, creditNote];
    const screen = await loadInvoice(session(A), CN);
    expect(screen?.state).toBe("ready");
    if (screen?.state === "ready") {
      expect(screen.invoice.kind).toBe("credit_note");
      expect(screen.invoice.number).toBe("TC-CN-2026-000001");
      expect(screen.invoice.credit).toEqual({
        originalNumber: "TC-2026-000012",
        originalIssuedAt: invoice.issuedAt,
        reason: "order_failed",
      });
      expect(screen.seller.legalNameEn).toBe("Seller Ltd");
    }
  });

  it("another customer's credit note answers like a missing one (R8)", async () => {
    state.rows = [invoice, creditNote];
    expect(await loadInvoice(session(B), CN)).toBeNull();
    expect(await loadInvoice(session(A), "0190aaaa-0000-7000-8000-0000000000ff")).toBeNull();
    expect((await invoiceDocument(deps(B), "en", CN)).status).toBe(404);
    expect((await invoiceDocument(deps(null), "en", CN)).status).toBe(401);
  });

  it("is not shown when the original invoice cannot be read, or the reason is missing (R16)", async () => {
    state.rows = [creditNote];
    expect(await loadInvoice(session(A), CN)).toEqual({ state: "unavailable" });
    state.rows = [invoice, { ...creditNote, reason: null }];
    expect(await loadInvoice(session(A), CN)).toEqual({ state: "unavailable" });
    expect((await invoiceDocument(deps(A), "en", CN)).status).toBe(500);
  });

  it("is not shown without the seller snapshot of the original (R16)", async () => {
    state.rows = [invoice, { ...creditNote, seller: null }];
    expect(await loadInvoice(session(A), CN)).toEqual({ state: "seller_missing" });
    expect((await invoiceDocument(deps(A), "en", CN)).status).toBe(503);
  });
});

describe("the printable document", () => {
  it("a credit note is the Mushak-6.7 with the original's buyer and seller and amounts", async () => {
    state.rows = [invoice, creditNote];
    const out = await invoiceDocument(deps(A), "en", CN);
    expect(out.status).toBe(200);
    const html = out.html as string;
    expect(html).toContain("<h1>Credit Note</h1>");
    expect(html).toContain("Mushak-6.7");
    expect(html).toContain("TC-CN-2026-000001");
    expect(html).toContain("<strong>Original invoice no.:</strong> TC-2026-000012");
    expect(html).toContain("<strong>Original invoice date:</strong> 14-11-2026");
    expect(html).toContain("Order failed");
    expect(html).toContain("Rahim Buyer");
    expect(html).toContain("630.00");
    expect(html).toContain("Original / মূল কপি");
  });

  it("an invoice prints the date of supply (the charge) and the date of issue (the later day)", async () => {
    state.rows = [invoice];
    const html = (await invoiceDocument(deps(A), "en", INV)).html as string;
    expect(html).toContain("<strong>Date of supply:</strong> 11-11-2026");
    expect(html).toContain("<strong>Date and time of issue:</strong> 14-11-2026");
    expect(html).toContain("Original / মূল কপি");
  });
});
