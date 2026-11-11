import { describe, expect, it } from "vitest";
import { LEDGER_ACCOUNT_TYPES as DATABASE_TYPES } from "@tc/db";
import { STEP_ACCOUNTS } from "../pricing/validate";
import { insertRow, newCustomer } from "@tc/db/testing";
import { useLedgerDatabase } from "../test/ledger-fixtures";
import { ensureSystemAccounts, openWallet } from "./accounts";
import { LEDGER_ACCOUNT_TYPES } from "./types";

const L = useLedgerDatabase();
const platformCount = async (currency: string) =>
  (
    await L.pool.query(
      "select count(*)::int as n from ledger_accounts where customer_id is null and currency = $1",
      [currency],
    )
  ).rows[0]!.n;

it("the nine account types are the ones of the database, and every pricing step posts to one of them", () => {
  expect([...LEDGER_ACCOUNT_TYPES]).toEqual([...DATABASE_TYPES]);
  for (const account of Object.values(STEP_ACCOUNTS))
    expect(LEDGER_ACCOUNT_TYPES).toContain(account);
});

describe("ensureSystemAccounts", () => {
  it("creates the eight platform accounts of a currency once", async () => {
    const first = await L.run((tx) => ensureSystemAccounts(tx, "USD"));
    expect(first.created).toEqual([
      "gateway_clearing",
      "revenue_aws_base",
      "vat_korea_payable",
      "vat_bd_payable",
      "processing_fee_income",
      "markup_income",
      "refunds",
      "adjustments",
    ]);
    expect(await L.run((tx) => ensureSystemAccounts(tx, "USD"))).toEqual({ created: [] });
    expect(await platformCount("USD")).toBe(8);
    expect(await platformCount("BDT")).toBe(8); // made by the set-up of the test file
  });
  it("runs as web_rw, and the other roles are refused (42501)", async () => {
    expect((await L.run((tx) => ensureSystemAccounts(tx, "EUR"), "web_rw")).created).toHaveLength(
      8,
    );
    for (const role of ["admin_rw", "worker_rw"] as const) {
      await expect(L.run((tx) => ensureSystemAccounts(tx, "GBP"), role)).rejects.toMatchObject({
        name: "DbError",
        code: "42501",
      });
    }
  });
  it.each(["bdt", "BD", "", "BDTX"])("refuses the currency %j", async (currency) => {
    await expect(L.run((tx) => ensureSystemAccounts(tx, currency))).rejects.toThrow(TypeError);
  });
});

describe("openWallet", () => {
  it("creates the wallet row and the customer_wallet account in the currency of the market, once", async () => {
    const customerId = (await L.newWallet()).customerId; // newWallet calls openWallet
    const again = await L.run((tx) => openWallet(tx, customerId), "web_rw");
    expect(again).toMatchObject({ ok: true, value: { currency: "BDT" } });
    const rows = await L.pool.query(
      `select (select count(*)::int from wallets where customer_id = $1) as wallets,
              (select count(*)::int from ledger_accounts where customer_id = $1) as accounts,
              (select balance_minor::text from wallets where customer_id = $1) as balance`,
      [customerId],
    );
    expect(rows.rows[0]).toEqual({ wallets: 1, accounts: 1, balance: "0" });
  });
  it("uses the currency of the market of the customer", async () => {
    const usd = await L.newWallet({ currency: "USD" });
    const row = await L.pool.query("select currency from wallets where customer_id = $1", [
      usd.customerId,
    ]);
    expect(row.rows[0]).toEqual({ currency: "USD" });
  });
  it("answers not_found for an unknown customer and validation for a bad id", async () => {
    expect(await L.run((tx) => openWallet(tx, crypto.randomUUID()), "web_rw")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await L.run((tx) => openWallet(tx, "42"), "web_rw")).toMatchObject({
      ok: false,
      error: "validation",
    });
  });
  it("answers conflict when a wallet of another currency exists already", async () => {
    const customerId = await newCustomer(L.pool);
    await insertRow(L.pool, "wallets", { customer_id: customerId, currency: "USD" });
    expect(await L.run((tx) => openWallet(tx, customerId), "web_rw")).toEqual({
      ok: false,
      error: "conflict",
    });
  });
  it("is refused to the roles that cannot insert a wallet (42501)", async () => {
    const customerId = await newCustomer(L.pool);
    for (const role of ["admin_rw", "worker_rw"] as const) {
      await expect(L.run((tx) => openWallet(tx, customerId), role)).rejects.toMatchObject({
        name: "DbError",
        code: "42501",
      });
    }
  });
});
