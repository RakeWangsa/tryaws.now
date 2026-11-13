import { describe, expect, it } from "vitest";
import { buildChargeSnapshot } from "../pricing/charge-snapshot";
import { quote } from "../pricing/quote";
import type { PricingRule } from "../pricing/types";
import { metered, purchase, renewal, topup } from "../test/ledger-requests";
import { checkPosting } from "./rules";

// WPU-Y2: the price snapshot of a sale is checked together with the postings, before anything is written.
const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};
function snapshot(kind: "purchase" | "renewal" | "metered") {
  return buildChargeSnapshot(kind, {
    pricedAt: new Date("2026-11-11T08:00:00.000Z"),
    awsPriceUsd: "5",
    quantity: "1",
    fx: { id: "fx-1", rate: "127", effectiveFrom: new Date("2026-11-10T00:00:00.000Z") },
    rule: { id: "rule-id-1", version: "rule-1" },
    book: null,
    quote: quote({ awsPriceUsd: "5", fxRate: "127", rule: RULE }),
  });
}

describe("priceSnapshot on a posting", () => {
  it("is accepted when its kind and its total match the posting, and is carried to the write", () => {
    const checked = checkPosting({ ...purchase(), priceSnapshot: snapshot("purchase") });
    expect(checked).toMatchObject({ ok: true, value: { walletDelta: -74295n } });
    expect(checked.ok && checked.value.priceSnapshot?.totalMinor).toBe("74295");
    expect(checkPosting({ ...renewal(), priceSnapshot: snapshot("renewal") }).ok).toBe(true);
    expect(checkPosting({ ...metered(), priceSnapshot: snapshot("metered") }).ok).toBe(true);
  });

  it("is required on a sale and optional on every other kind (WPU-Y9, R16)", () => {
    for (const sale of [purchase(), renewal(), metered()]) {
      const bare: Partial<typeof sale> = { ...sale };
      delete bare.priceSnapshot;
      expect(checkPosting(bare)).toMatchObject({
        ok: false,
        error: "validation",
        fields: { priceSnapshot: expect.any(String) },
      });
      expect(checkPosting({ ...bare, priceSnapshot: null }).ok).toBe(false);
    }
    const checked = checkPosting(topup());
    expect(checked.ok && checked.value.priceSnapshot).toBeNull();
  });

  it("is refused when its total is not the debit of the wallet (R16)", () => {
    const wrong = { ...snapshot("purchase"), totalMinor: "74296", baseMinor: "63501" };
    expect(checkPosting({ ...purchase(), priceSnapshot: wrong })).toMatchObject({
      ok: false,
      error: "validation",
      fields: { priceSnapshot: expect.any(String) },
    });
  });

  it("is refused when it is of another kind, when it is damaged, and on a kind that is no sale", () => {
    expect(checkPosting({ ...purchase(), priceSnapshot: snapshot("renewal") }).ok).toBe(false);
    expect(checkPosting({ ...purchase(), priceSnapshot: { schemaVersion: 1 } }).ok).toBe(false);
    expect(checkPosting({ ...topup(), priceSnapshot: snapshot("purchase") }).ok).toBe(false);
  });
});
