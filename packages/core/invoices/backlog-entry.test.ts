import { describe, expect, it } from "vitest";
import type { UnrecordedCharge } from "@tc/db";
import { buildChargeSnapshot, chargeToPriceSnapshot } from "../pricing/charge-snapshot";
import { quoteWithBook } from "../pricing/book";
import type { PricingRule } from "../pricing/types";
import { backlogEntryOf } from "./backlog";
import { invoiceLinesOf } from "./charge";

// WPU-Y9 finding 6: the reconciliation rebuilds the lines from the snapshot saved with the charge.
const label = { bn: "ক", en: "a" };
const rule: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};
const snapshotAt = (fxRate: string, kind: "purchase" | "renewal" = "purchase") =>
  buildChargeSnapshot(kind, {
    pricedAt: new Date("2026-11-11T08:00:00.000Z"),
    awsPriceUsd: "5",
    quantity: "1",
    fx: { id: "fx-1", rate: fxRate, effectiveFrom: new Date("2026-11-10T00:00:00.000Z") },
    rule: { id: "rule-id-1", version: "rule-1" },
    book: null,
    quote: quoteWithBook({ awsPriceUsd: "5", quantity: "1", fxRate, rule }, null).quote,
  });
const OID = "0190aaaa-0000-7000-8000-0000000000a1";
const charge = (over: Partial<UnrecordedCharge>): UnrecordedCharge => ({
  customerId: "0190aaaa-0000-7000-8000-0000000000c1",
  kind: "order",
  orderId: OID,
  ledgerTransactionId: "0190aaaa-0000-7000-8000-0000000000d1",
  totalMinor: 74295n,
  priceSnapshot: null,
  chargeSnapshot: null,
  ...over,
});

describe("backlogEntryOf", () => {
  it("builds the lines of an order from the snapshot saved with the charge", () => {
    const saved = snapshotAt("127");
    const entry = backlogEntryOf(charge({ chargeSnapshot: saved }));
    expect(entry).toEqual({
      kind: "order",
      orderId: OID,
      lines: invoiceLinesOf(chargeToPriceSnapshot(saved)),
    });
  });

  it("the saved charge wins over the order row: a later rate change cannot change the rebuilt invoice", () => {
    const saved = snapshotAt("127");
    const after = snapshotAt("140"); // what a recalculation after the charge would give
    const entry = backlogEntryOf(
      charge({ chargeSnapshot: saved, priceSnapshot: chargeToPriceSnapshot(after) }),
    );
    expect(entry?.lines).toEqual(invoiceLinesOf(chargeToPriceSnapshot(saved)));
    expect(entry?.lines).not.toEqual(invoiceLinesOf(chargeToPriceSnapshot(after)));
  });

  it("queues a renewal when its charge has a saved snapshot (no order id)", () => {
    const entry = backlogEntryOf(
      charge({ kind: "renewal", orderId: null, chargeSnapshot: snapshotAt("127", "renewal") }),
    );
    expect(entry).toMatchObject({ kind: "renewal", orderId: null });
    expect(entry?.lines.length).toBeGreaterThan(0);
  });

  it("a legacy renewal (no saved snapshot) can only be noted", () => {
    expect(backlogEntryOf(charge({ kind: "renewal", orderId: null }))).toBeNull();
  });

  it("a legacy order falls back to the snapshot of its order row", () => {
    const orderRow = chargeToPriceSnapshot(snapshotAt("127"));
    const entry = backlogEntryOf(charge({ priceSnapshot: orderRow }));
    expect(entry?.lines).toEqual(invoiceLinesOf(orderRow));
  });

  it("a damaged or unknown saved snapshot is noted, never guessed (R16)", () => {
    expect(
      backlogEntryOf(charge({ chargeSnapshot: { schemaVersion: 1, kind: "purchase" } })),
    ).toBeNull();
    expect(backlogEntryOf(charge({ chargeSnapshot: { schemaVersion: 9 } }))).toBeNull();
  });
});
