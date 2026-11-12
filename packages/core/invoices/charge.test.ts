import { describe, expect, it } from "vitest";
import { quote } from "../pricing/quote";
import { toSnapshot } from "../pricing/snapshot";
import type { PricingRule } from "../pricing/types";
import { invoiceIdFor, invoiceLinesOf, queueIdFor } from "./charge";
import { renderInvoiceHtml, type InvoiceDocument } from "./index";

// WPU-I2: the lines of a charge come from the snapshot that priced it; the VAT rate travels with its
// line and prints in the rate cell of the Mushak 6.3 invoice; no amount depends on it.
const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "bd-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};
const snapshot = toSnapshot(quote({ awsPriceUsd: "5", fxRate: "127", rule: RULE }), {
  awsPriceUsd: "5",
  pricedAt: new Date("2026-11-11T08:00:00.000Z"),
});
const seller = {
  legalNameBn: "বিক্রেতা",
  legalNameEn: "Seller Ltd",
  bin: "1234567890123",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  signatoryName: "A",
  signatoryDesignation: "B",
};

describe("invoiceLinesOf", () => {
  it("is the AWS price and one line for each step above 0, the rate with its step, the sum the total", () => {
    const lines = invoiceLinesOf(snapshot);
    expect(lines.map((l) => [l.code, l.amountMinor, l.rate])).toEqual([
      ["aws", "63500", undefined],
      ["korea_vat", "6350", "0.10"],
      ["bd_vat", "3175", "0.05"],
      ["processing_fee", "1270", "0.02"],
    ]);
    expect(lines.reduce((sum, l) => sum + BigInt(l.amountMinor), 0n)).toBe(74295n);
    for (const line of lines) {
      expect(line.label.bn.length).toBeGreaterThan(0);
      expect(line.label.en.length).toBeGreaterThan(0);
    }
  });

  it("a snapshot stored before the rate existed gives lines without a rate (the cell prints a dash)", () => {
    const old = {
      ...snapshot,
      steps: snapshot.steps.map(({ code, amountMinor }) => ({ code, amountMinor })),
    };
    expect(invoiceLinesOf(old).find((l) => l.code === "bd_vat")?.rate).toBeUndefined();
  });

  it("refuses a step it has no name for instead of printing an unnamed line (R16)", () => {
    const odd = {
      ...snapshot,
      steps: [{ code: "mystery", amountMinor: "10" }],
      totalMinor: String(63500 + 10),
    };
    expect(() => invoiceLinesOf(odd)).toThrow("invoice: invalid_lines");
  });

  it("the VAT rate prints in the rate cell of the tax invoice, and the amounts do not change", () => {
    const doc: InvoiceDocument = {
      seller,
      kind: "invoice",
      number: "TC-2026-000001",
      issuedAt: new Date("2026-11-11T05:00:00Z"),
      company: { name: "x", address: [] },
      customer: { name: "Rahim" },
      lines: invoiceLinesOf(snapshot),
      totalMinor: 74295n,
    };
    const html = renderInvoiceHtml(doc, "en");
    expect(html).toContain('<td class="num">5%</td>');
    expect(html).toContain("742.95");
    expect(html).toContain("31.75");
    // the same document with the rate taken off prints no rate, and the same amounts
    const without = renderInvoiceHtml(
      {
        ...doc,
        lines: doc.lines.map((l) => ({
          kind: l.kind,
          code: l.code,
          label: l.label,
          amountMinor: l.amountMinor,
        })),
      },
      "en",
    );
    expect(without).not.toContain('<td class="num">5%</td>');
    expect(without).toContain('<td class="num">-</td><td class="num">31.75</td>');
    expect(without).toContain("742.95");
    expect(without).toContain("31.75");
  });
});

describe("the ids of an invoice and of its queue entry", () => {
  const tx = "0190aaaa-0000-7000-8000-0000000000a1";
  it("are derived from the ledger transaction: the same charge, the same id (R7)", () => {
    expect(invoiceIdFor(tx)).toBe(invoiceIdFor(tx));
    expect(invoiceIdFor(tx)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(queueIdFor(tx)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(queueIdFor(tx)).not.toBe(invoiceIdFor(tx));
    expect(invoiceIdFor(tx.replace("a1", "a2"))).not.toBe(invoiceIdFor(tx));
  });
});
