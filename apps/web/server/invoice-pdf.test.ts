import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-N1: "Download PDF". Order of R9, cross-tenant proof (R8), the customer id sent to the renderer is the
// session's, fail closed (R16). The invoice read is the same mock as the printable page's test.

const snapshotOf = vi.hoisted(() => (stored: unknown): unknown => {
  const s = stored as { state: string; seller?: unknown; version?: number };
  if (s.state === "ok") return { v: 1, version: s.version ?? 1, ...(s.seller as object) };
  return null;
});

const state = vi.hoisted(() => ({
  rows: [] as { id: string; customerId: string; lines: unknown; totalMinor: bigint }[],
  seller: { state: "none" } as unknown,
}));
vi.mock("@tc/db", async () => ({
  parseSellerRowValue: (await vi.importActual<typeof import("@tc/db")>("@tc/db"))
    .parseSellerRowValue,
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => ({
    profile: { get: async () => ({ id: customerId, market: "BD", name: "Rahim" }) },
    invoices: {
      get: async (id: string) => {
        const found = state.rows.find((r) => r.id === id && r.customerId === customerId);
        return found === undefined
          ? null
          : {
              seller: snapshotOf(state.seller),
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

const { invoicePdf, INVOICE_PDF_HEADERS, INVOICE_PDF_RATE_LIMITS } =
  await import("./invoice-pdf.ts");
import type { RendererInput, RendererPort } from "./renderer-invoke.ts";

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
const SELLER = {
  legalNameBn: "বিক্রেতা লিমিটেড",
  legalNameEn: "Seller Ltd",
  bin: "1234567890123",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  signatoryName: "Karim",
  signatoryDesignation: "Director",
};
const PDF = new TextEncoder().encode("%PDF-1.4 test");

beforeEach(() => {
  state.seller = { state: "ok", seller: SELLER, version: 1 };
  state.rows = [{ id: INV, customerId: A, lines: LINES, totalMinor: 69000n }];
});

function setup(
  customerId: string | null,
  over: {
    render?: RendererPort["render"];
    renderer?: RendererPort | null;
    allowed?: boolean;
  } = {},
) {
  const calls: RendererInput[] = [];
  const renderer: RendererPort | null =
    over.renderer !== undefined
      ? over.renderer
      : {
          render:
            over.render ??
            (async (input) => {
              calls.push(input);
              return { ok: true, pdf: PDF };
            }),
        };
  const limited: string[] = [];
  return {
    calls,
    limited,
    deps: {
      session: customerId === null ? null : ({ customerId } as never),
      customerName: async () => "Rahim",
      renderer,
      rateLimit: async (s: { customerId: string }) => {
        limited.push(s.customerId);
        return { allowed: over.allowed ?? true };
      },
    },
  };
}

describe("Download PDF", () => {
  it("answers 401 without a session and touches nothing (R9)", async () => {
    const { deps, calls, limited } = setup(null);
    expect(await invoicePdf(deps, "en", INV)).toEqual({ status: 401 });
    expect(calls).toHaveLength(0);
    expect(limited).toHaveLength(0);
  });

  it("renders the invoice of the session's customer and returns the bytes", async () => {
    const { deps, calls, limited } = setup(A);
    const out = await invoicePdf(deps, "bn", INV);
    expect(out).toEqual({ status: 200, pdf: PDF, filename: `invoice-${INV}.pdf` });
    expect(limited).toEqual([A]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.customerId).toBe(A);
    expect(calls[0]?.invoiceId).toBe(INV);
    expect(calls[0]?.locale).toBe("bn");
    expect(calls[0]?.html).toContain("TC-2026-000012");
  });

  it("cross-tenant: another customer's invoice answers 404 and the renderer is never called (R8)", async () => {
    const { deps, calls } = setup(B);
    expect(await invoicePdf(deps, "en", INV)).toEqual({ status: 404 });
    expect(calls).toHaveLength(0);
  });

  it("a malformed id is a 404 before anything is read", async () => {
    const { deps, calls, limited } = setup(A);
    expect(await invoicePdf(deps, "en", "../../etc")).toEqual({ status: 404 });
    expect(calls).toHaveLength(0);
    expect(limited).toHaveLength(0);
  });

  it("rate limited: 'busy', and the renderer is not called", async () => {
    const { deps, calls } = setup(A, { allowed: false });
    expect(await invoicePdf(deps, "en", INV)).toEqual({ status: 303, notice: "busy" });
    expect(calls).toHaveLength(0);
  });

  it("fails closed: no renderer configured, renderer error, throw, too large, no seller", async () => {
    expect(await invoicePdf(setup(A, { renderer: null }).deps, "en", INV)).toEqual({
      status: 303,
      notice: "unavailable",
    });
    expect(
      await invoicePdf(
        setup(A, { render: async () => ({ ok: false, error: "unavailable" }) }).deps,
        "en",
        INV,
      ),
    ).toEqual({ status: 303, notice: "unavailable" });
    expect(
      await invoicePdf(
        setup(A, {
          render: async () => {
            throw new Error("arn:aws:lambda:secret");
          },
        }).deps,
        "en",
        INV,
      ),
    ).toEqual({ status: 303, notice: "unavailable" });
    expect(
      await invoicePdf(
        setup(A, { render: async () => ({ ok: false, error: "not_ready" }) }).deps,
        "en",
        INV,
      ),
    ).toEqual({ status: 303, notice: "not_ready" });
    state.seller = { state: "none" };
    const noSeller = setup(A);
    expect(await invoicePdf(noSeller.deps, "en", INV)).toEqual({
      status: 303,
      notice: "unavailable",
    });
    expect(noSeller.calls).toHaveLength(0);
  });

  it("serves private, no-store, as a PDF", () => {
    expect(INVOICE_PDF_HEADERS["Content-Type"]).toBe("application/pdf");
    expect(INVOICE_PDF_HEADERS["Cache-Control"]).toBe("private, no-store");
    expect(INVOICE_PDF_RATE_LIMITS[0]?.action).toBe("invoice.pdf");
  });
});
