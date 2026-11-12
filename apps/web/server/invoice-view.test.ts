import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-G4: /invoices and /invoices/[id]. The pure helpers are tested here; the cross-tenant proof of the
// loaders is the last describe (R8, R16).

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as unknown[][],
  throwOnRead: false,
  // WPU-I1: what readInvoiceSeller answers for the market of the customer.
  seller: { state: "none" } as unknown,
}));

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readInvoiceSeller: async () => state.seller,
  customerRepos: (_tx: unknown, customerId: string) => ({
    profile: { get: async () => ({ id: customerId, market: "BD", name: "Rahim" }) },
    invoices: {
      list: async (opts: unknown) => {
        state.calls.push(["list", customerId, opts]);
        if (state.throwOnRead) throw new Error("db down arn:aws:rds:x");
        const mine = (state.rows as { customerId: string }[]).filter(
          (r) => r.customerId === customerId,
        );
        return { items: mine, next: null };
      },
      get: async (id: string) => {
        state.calls.push(["get", customerId, id]);
        if (state.throwOnRead) throw new Error("db down");
        return (
          (state.rows as { id: string; customerId: string }[]).find(
            (r) => r.id === id && r.customerId === customerId,
          ) ?? null
        );
      },
    },
  }),
}));

const { loadInvoice, loadInvoiceList, parseInvoiceCursor, formatInvoiceCursor, parseStoredLines } =
  await import("./invoice-view.ts");

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
  { kind: "step", code: "vat", label: { bn: "ভ্যাট", en: "VAT" }, amountMinor: "9000" },
];
const row = (over: Record<string, unknown> = {}) => ({
  id: INV,
  customerId: A,
  fiscalYear: 2026,
  number: 12,
  orderId: null,
  lines: LINES,
  totalMinor: 69000n,
  issuedAt: new Date("2026-11-01T06:00:00Z"),
  pdfKey: null,
  ...over,
});
const session = (customerId: string) => ({ customerId }) as never;
const SELLER = {
  legalNameBn: "ক",
  legalNameEn: "Seller Ltd",
  bin: "0000000000000",
  addressBn: "ক",
  addressEn: "Dhaka",
  signatoryName: "A",
  signatoryDesignation: "B",
};
beforeEach(() => {
  state.seller = { state: "ok", seller: SELLER, version: 1 };
});

describe("the cursor of the list", () => {
  it("round-trips fiscal year and number and refuses everything else", () => {
    expect(parseInvoiceCursor("2026-12")).toEqual({ fiscalYear: 2026, number: 12 });
    expect(formatInvoiceCursor({ fiscalYear: 2026, number: 12 })).toBe("2026-12");
    for (const bad of [
      undefined,
      "",
      "2026",
      "2026-",
      "-5",
      "2026-0",
      "20x6-1",
      "2026-1-1",
      "2026-9999999",
      "1999-1",
      " 2026-1",
    ]) {
      expect(parseInvoiceCursor(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseStoredLines", () => {
  it("returns lines that add up to the total", () => {
    const parsed = parseStoredLines(LINES, 69000n);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed![0]!.amountMinor).toBe(60000n);
  });
  it("refuses lines that do not add up, an empty list, a bad amount and a missing label (R16)", () => {
    expect(parseStoredLines(LINES, 69001n)).toBeNull();
    expect(parseStoredLines([], 0n)).toBeNull();
    expect(parseStoredLines("x", 1n)).toBeNull();
    expect(parseStoredLines([{ ...LINES[0], amountMinor: "-1" }], 0n)).toBeNull();
    expect(parseStoredLines([{ ...LINES[0], amountMinor: 600 }], 600n)).toBeNull();
    expect(parseStoredLines([{ ...LINES[0], label: { en: "only" } }], 60000n)).toBeNull();
  });
});

describe("loadInvoiceList", () => {
  it("is empty without invoices, and lists the session's customer only (R8)", async () => {
    state.rows = [];
    expect(await loadInvoiceList(session(A), undefined)).toEqual({ state: "empty" });
    state.rows = [
      row(),
      row({ id: "0190aaaa-0000-7000-8000-0000000000e2", customerId: B, number: 7 }),
    ];
    const screen = await loadInvoiceList(session(A), undefined);
    expect(screen.state).toBe("ready");
    if (screen.state === "ready") {
      expect(screen.items.map((i) => i.number)).toEqual(["TC-2026-000012"]);
      expect(screen.items[0]!.totalMinor).toBe(69000n);
    }
  });
  it("passes a valid cursor on and ignores a bad one", async () => {
    state.rows = [row()];
    state.calls = [];
    await loadInvoiceList(session(A), "2026-12");
    await loadInvoiceList(session(A), "junk");
    const opts = state.calls.map((c) => c[2]) as { after?: unknown }[];
    expect(opts[0]!.after).toEqual({ fiscalYear: 2026, number: 12 });
    expect(opts[1]!.after).toBeUndefined();
  });
  it("throws a database error instead of showing an empty list (R16)", async () => {
    state.throwOnRead = true;
    await expect(loadInvoiceList(session(A), undefined)).rejects.toThrow();
    state.throwOnRead = false;
  });
});

describe("loadInvoice", () => {
  it("returns the invoice of the session's customer with parsed lines", async () => {
    state.rows = [row()];
    const out = await loadInvoice(session(A), INV);
    expect(out?.state).toBe("ready");
    if (out?.state === "ready") {
      expect(out.invoice.number).toBe("TC-2026-000012");
      expect(out.invoice.totalMinor).toBe(69000n);
      expect(out.invoice.lines).toHaveLength(2);
    }
  });
  it("answers null for another customer's invoice like for a missing one (R8)", async () => {
    state.rows = [row()];
    expect(await loadInvoice(session(B), INV)).toBeNull();
    expect(await loadInvoice(session(A), "0190aaaa-0000-7000-8000-0000000000ff")).toBeNull();
  });
  it("says 'unavailable' when the stored lines do not add up, and never prints a wrong total (R16)", async () => {
    state.rows = [row({ totalMinor: 70000n })];
    expect(await loadInvoice(session(A), INV)).toEqual({ state: "unavailable" });
  });
  it("carries the seller of the customer's market with a ready invoice (WPU-I1)", async () => {
    state.rows = [row()];
    const out = await loadInvoice(session(A), INV);
    expect(out).toMatchObject({ state: "ready", seller: { legalNameEn: "Seller Ltd" } });
  });
  it("says 'seller_missing' when the seller details are absent or unreadable, never a half tax invoice (R16)", async () => {
    state.rows = [row()];
    for (const stored of [
      { state: "none" },
      { state: "invalid" },
      // a row that the reader accepted but the core refuses: a blank signatory
      { state: "ok", seller: { ...SELLER, signatoryName: " " }, version: 1 },
    ]) {
      state.seller = stored;
      expect(await loadInvoice(session(A), INV), JSON.stringify(stored)).toEqual({
        state: "seller_missing",
      });
    }
  });
  it("another customer's invoice is still null even when the seller is missing (R8)", async () => {
    state.rows = [row()];
    state.seller = { state: "none" };
    expect(await loadInvoice(session(B), INV)).toBeNull();
  });
  it("keeps the stored VAT rate of a line and refuses a rate that is not decimal text", async () => {
    const vat = { ...LINES[1], code: "bd_vat", rate: "0.05" };
    expect(parseStoredLines([LINES[0], vat], 69000n)?.[1]?.rate).toBe("0.05");
    expect(parseStoredLines([LINES[0], { ...vat, rate: "5%" }], 69000n)).toBeNull();
    expect(parseStoredLines([LINES[0], { ...vat, rate: 0.05 }], 69000n)).toBeNull();
  });
});
