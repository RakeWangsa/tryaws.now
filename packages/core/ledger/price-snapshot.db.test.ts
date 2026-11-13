import { describe, expect, it } from "vitest";
import { buildChargeSnapshot, readChargeSnapshot } from "../pricing/charge-snapshot";
import { quote } from "../pricing/quote";
import type { PricingRule } from "../pricing/types";
import { inputs, transactionIdOf, useLedgerDatabase } from "../test/ledger-fixtures";
import { postTransaction } from "./post";
import type { PostTransactionInput } from "./types";

// WPU-Y2 (database test: needs PostgreSQL, `pnpm db:up`). The price snapshot is written with the header,
// in the same transaction as the postings, and the append-only trigger keeps it as it was.
const L = useLedgerDatabase();
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
const snap = buildChargeSnapshot("purchase", {
  pricedAt: new Date("2026-11-11T08:00:00.000Z"),
  awsPriceUsd: "5",
  quantity: "1",
  fx: { id: "fx-1", rate: "127", effectiveFrom: new Date("2026-11-10T00:00:00.000Z") },
  rule: { id: "rule-id-1", version: "rule-1" },
  book: null,
  quote: quote({ awsPriceUsd: "5", fxRate: "127", rule: RULE }),
});

describe("ledger_transactions.price_snapshot", () => {
  it("is saved with the purchase and read back as the same snapshot", async () => {
    const w = await L.newWallet();
    await L.fund(w, 150000n);
    const input = { ...inputs.purchase(w.customerId), priceSnapshot: snap };
    const id = transactionIdOf(
      await L.run((tx) => postTransaction(tx, input as PostTransactionInput)),
    );
    const row = await L.pool.query("select price_snapshot from ledger_transactions where id = $1", [
      id,
    ]);
    expect(readChargeSnapshot(row.rows[0].price_snapshot)).toEqual({
      state: "snapshot",
      value: snap,
    });
  });

  it("is NULL on a posting without one (a top-up, or a legacy row)", async () => {
    const w = await L.newWallet();
    const id = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.topup(w.customerId, 5000n))),
    );
    const row = await L.pool.query("select price_snapshot from ledger_transactions where id = $1", [
      id,
    ]);
    expect(row.rows[0].price_snapshot).toBeNull();
  });

  it("cannot be changed afterwards (append-only)", async () => {
    const w = await L.newWallet();
    await L.fund(w, 150000n);
    const input = { ...inputs.purchase(w.customerId), priceSnapshot: snap };
    const id = transactionIdOf(
      await L.run((tx) => postTransaction(tx, input as PostTransactionInput)),
    );
    await expect(
      L.pool.query("update ledger_transactions set price_snapshot = '{}' where id = $1", [id]),
    ).rejects.toThrow();
  });
});
