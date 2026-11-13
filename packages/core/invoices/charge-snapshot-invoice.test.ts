import { describe, expect, it } from "vitest";
import {
  buildChargeSnapshot,
  chargeToPriceSnapshot,
  type ChargeInputs,
} from "../pricing/charge-snapshot";
import { quoteWithBook } from "../pricing/book";
import type { PricingRule } from "../pricing/types";
import { creditNoteLinesOf, resolveChargeLines } from "./charge-lines";
import { invoiceLinesOf } from "./charge";
import { renderInvoiceHtml, type InvoiceDocument } from "./index";

// WPU-Y2: invoices and credit notes are rebuilt from the saved charge, never recalculated.
const label = { bn: "ক", en: "a" };
const ruleWith = (markup: string): PricingRule => ({
  version: markup === "0" ? "rule-1" : "rule-2",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: markup, base: "aws", label },
  ],
});
function priced(fxRate: string, markup: string): ChargeInputs {
  const rule = ruleWith(markup);
  return {
    pricedAt: new Date("2026-11-11T08:00:00.000Z"),
    awsPriceUsd: "5",
    quantity: "1",
    fx: {
      id: "0190aaaa-0000-7000-8000-0000000000f1",
      rate: fxRate,
      effectiveFrom: new Date("2026-11-10T00:00:00.000Z"),
    },
    rule: { id: "0190aaaa-0000-7000-8000-0000000000e1", version: rule.version },
    book: null,
    quote: quoteWithBook({ awsPriceUsd: "5", quantity: "1", fxRate, rule }, null).quote,
  };
}
const seller = {
  legalNameBn: "ক",
  legalNameEn: "Seller",
  bin: "1234567890123",
  addressBn: "ঢ",
  addressEn: "Dhaka",
  signatoryName: "A",
  signatoryDesignation: "B",
};

function doc(
  kind: "invoice" | "credit_note",
  lines: ReturnType<typeof invoiceLinesOf>,
  total: bigint,
): InvoiceDocument {
  return {
    kind,
    number: "TC-2026-000001",
    issuedAt: new Date("2026-11-11T05:00:00Z"),
    company: { name: "x", address: [] },
    seller,
    customer: { name: "Rahim" },
    lines,
    totalMinor: total,
    ...(kind === "credit_note"
      ? {
          credit: {
            originalNumber: "TC-2026-000001",
            originalIssuedAt: new Date("2026-11-11T05:00:00Z"),
            reason: "refund" as const,
          },
        }
      : {}),
  };
}

describe("invoice and credit note from the saved charge", () => {
  const original = buildChargeSnapshot("purchase", priced("127", "0"));
  const saved: unknown = JSON.parse(JSON.stringify(original));
  const total = BigInt(original.totalMinor);

  it("rebuilt after the rate and the markup changed: byte-identical, original amounts", () => {
    const html1 = renderInvoiceHtml(
      doc("invoice", resolveChargeLines(saved, []).lines, total),
      "en",
    );
    // today's data moves: another rate and another markup would price differently ...
    const today = buildChargeSnapshot("purchase", priced("140", "0.30"));
    expect(today.totalMinor).not.toBe(original.totalMinor);
    // ... but the rebuild reads only what was saved.
    const html2 = renderInvoiceHtml(
      doc("invoice", resolveChargeLines(saved, []).lines, total),
      "en",
    );
    expect(html2).toBe(html1);
    expect(html1).toContain("742.95");
  });

  it("a full-reversal credit note reverses the exact snapshot amounts and is stable", () => {
    const lines = creditNoteLinesOf(saved);
    expect(lines).toEqual(invoiceLinesOf(chargeToPriceSnapshot(original)));
    const a = renderInvoiceHtml(doc("credit_note", lines, total), "en");
    const b = renderInvoiceHtml(doc("credit_note", creditNoteLinesOf(saved), total), "en");
    expect(a).toBe(b);
    expect(lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n)).toBe(total);
  });

  it("prints no USD", () => {
    const html = renderInvoiceHtml(
      doc("invoice", resolveChargeLines(saved, []).lines, total),
      "en",
    );
    expect(html).not.toMatch(/USD|\$/);
  });

  it("a legacy charge (no snapshot) renders from the stored lines, marked legacy, nothing recalculated", () => {
    const stored = invoiceLinesOf(chargeToPriceSnapshot(original));
    const r = resolveChargeLines(null, stored);
    expect(r.source).toBe("legacy");
    expect(r.lines).toEqual(stored);
  });

  it("a damaged snapshot fails closed", () => {
    expect(() => resolveChargeLines({ schemaVersion: 1, kind: "purchase" }, [])).toThrow();
  });
});
