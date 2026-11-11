import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  applyCatalogScope,
  applyTlds,
  listCatalogKeys,
  readPoolAccountRef,
  type CatalogRowWrite,
} from "../repositories/system/catalog-sync";
import { runTransaction, type DatabaseRole } from "../tx";
import {
  ensureMarket,
  newCustomer,
  newLedgerTransaction,
  newPoolAccount,
  uniqueSuffix,
} from "./fixtures";
import { expectSqlError, inTransaction, insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// Needs the local PostgreSQL (pnpm db:up). Runs as worker_rw, the role of the catalog-sync function.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });
const T1 = new Date("2026-11-11T06:00:00Z");
const T2 = new Date("2026-11-12T06:00:00Z");
const REGION = "ap-southeast-1";

const row = (awsId: string, over: Partial<CatalogRowWrite> = {}): CatalogRowWrite => ({
  family: "linux_instance",
  awsId,
  platform: "linux",
  region: REGION,
  specs: { vcpus: 2, ramGb: "0.5" },
  awsPriceUsd: "5",
  billingUnit: "month",
  featureFlag: "linux_instance",
  active: true,
  ...over,
});
const three = () => [row("nano_3_0"), row("micro_3_0", { awsPriceUsd: "7" }), row("small_3_0")];
const stored = async (awsId: string) =>
  (
    await t.pool.query(
      `select id, created_at, synced_at, aws_price_usd::text as price, active, feature_flag
         from catalog_products where aws_id = $1 and region = $2`,
      [awsId, REGION],
    )
  ).rows[0];
const count = async () =>
  Number((await t.pool.query("select count(*) c from catalog_products")).rows[0].c);

it("inserts 3 rows, then updates 3 and inserts 0: same ids, same created_at, new synced_at (R7)", async () => {
  const first = await as("worker_rw", (tx) =>
    applyCatalogScope(tx, { rows: three(), deactivate: [], at: T1 }),
  );
  expect(first).toEqual({ inserted: 3, updated: 0, deactivated: 0 });
  const before = await stored("nano_3_0");
  const second = await as("worker_rw", (tx) =>
    applyCatalogScope(tx, { rows: three(), deactivate: [], at: T2 }),
  );
  expect(second).toEqual({ inserted: 0, updated: 3, deactivated: 0 });
  const after = await stored("nano_3_0");
  expect(after.id).toBe(before.id);
  expect(after.created_at).toEqual(before.created_at);
  expect(after.synced_at).toEqual(T2);
  expect(await count()).toBe(3);
});

it("a changed price updates the catalog row and no order, subscription or price snapshot", async () => {
  await ensureMarket(t.pool);
  const customerId = await newCustomer(t.pool);
  const snapshot = JSON.stringify({ v: 1, awsPriceUsd: "5", fxRate: "127" });
  const ledgerTransactionId = await newLedgerTransaction(t.pool, customerId);
  const orderId = await insertRow(t.pool, "orders", {
    customer_id: customerId,
    kind: "new",
    items: "[]",
    price_snapshot: snapshot,
    total_minor: 100,
    ledger_transaction_id: ledgerTransactionId,
    idempotency_key: "o-" + uniqueSuffix(),
  });
  const orderBefore = (await t.pool.query("select * from orders where id = $1", [orderId])).rows;
  const subsBefore = (await t.pool.query("select * from subscriptions")).rows;
  await as("worker_rw", (tx) =>
    applyCatalogScope(tx, {
      rows: [row("nano_3_0", { awsPriceUsd: "9.5" })],
      deactivate: [],
      at: T2,
    }),
  );
  expect((await stored("nano_3_0")).price).toBe("9.5000");
  expect((await t.pool.query("select * from orders where id = $1", [orderId])).rows).toEqual(
    orderBefore,
  );
  expect((await t.pool.query("select * from subscriptions")).rows).toEqual(subsBefore);
});

it("deactivate turns a row off and keeps it; an unknown key changes nothing and does not throw", async () => {
  const result = await as("worker_rw", (tx) =>
    applyCatalogScope(tx, {
      rows: [],
      deactivate: [
        { family: "linux_instance", awsId: "micro_3_0", region: REGION },
        { family: "linux_instance", awsId: "never_seen", region: REGION },
      ],
      at: T2,
    }),
  );
  expect(result).toEqual({ inserted: 0, updated: 0, deactivated: 1 });
  const row2 = await stored("micro_3_0");
  expect(row2.active).toBe(false);
  expect(row2.synced_at).toEqual(T2);
});

it("listCatalogKeys lists the keys of one Region and the given families", async () => {
  await as("worker_rw", (tx) =>
    applyCatalogScope(tx, {
      rows: [
        row("w_1", {
          family: "windows_instance",
          platform: "windows",
          featureFlag: "windows_instance",
        }),
      ],
      deactivate: [],
      at: T2,
    }),
  );
  const keys = await as("worker_rw", (tx) =>
    listCatalogKeys(tx, { region: REGION, families: ["linux_instance"] }),
  );
  expect(keys.map((k) => k.awsId).sort()).toEqual(["micro_3_0", "nano_3_0", "small_3_0"]);
  expect(keys.find((k) => k.awsId === "micro_3_0")!.active).toBe(false);
});

it("worker_rw cannot update feature_flag or family, and cannot delete (pinned by grant)", async () => {
  await expectSqlError(
    inTransaction(t.pool, async (c) => {
      await c.query("SET LOCAL ROLE worker_rw");
      await c.query("update catalog_products set family = 'disk' where aws_id = 'nano_3_0'");
    }),
    "42501",
  );
  await expectSqlError(
    inTransaction(t.pool, async (c) => {
      await c.query("SET LOCAL ROLE worker_rw");
      await c.query("delete from catalog_products");
    }),
    "42501",
  );
});

it("a transaction that fails in the middle leaves no half-written scope", async () => {
  const before = await count();
  await expect(
    as("worker_rw", async (tx) => {
      await applyCatalogScope(tx, {
        rows: [row("rollback_1"), row("rollback_2")],
        deactivate: [],
        at: T2,
      });
      throw new Error("forced");
    }),
  ).rejects.toThrow("forced");
  expect(await count()).toBe(before);
});

it("applyTlds inserts, updates a price, and leaves a TLD that is absent from the next answer", async () => {
  const tld = (name: string, reg: string | null) => ({
    tld: name,
    registrationUsd: reg,
    renewalUsd: "14.5",
    transferUsd: null,
    needsExtraParams: name === "us",
  });
  const first = await as("worker_rw", (tx) =>
    applyTlds(tx, { rows: [tld("com", "12"), tld("us", "9")], at: T1 }),
  );
  expect(first).toEqual({ inserted: 2, updated: 0 });
  const second = await as("worker_rw", (tx) => applyTlds(tx, { rows: [tld("com", "13")], at: T2 }));
  expect(second).toEqual({ inserted: 0, updated: 1 });
  const rows = (
    await t.pool.query(
      "select tld, registration_price_usd::text as reg, needs_extra_params as x, synced_at from tlds order by tld",
    )
  ).rows;
  expect(rows).toEqual([
    { tld: "com", reg: "13.0000", x: false, synced_at: T2 },
    { tld: "us", reg: "9.0000", x: true, synced_at: T1 },
  ]);
});

it("readPoolAccountRef gives the pair of an active account and null for suspended or unknown ones", async () => {
  const id = await newPoolAccount(t.pool);
  const account = (
    await t.pool.query("select aws_account_id, external_id from pool_accounts where id = $1", [id])
  ).rows[0];
  expect(await as("worker_rw", (tx) => readPoolAccountRef(tx, account.aws_account_id))).toEqual({
    awsAccountId: account.aws_account_id,
    externalId: account.external_id,
  });
  await t.pool.query("update pool_accounts set status = 'suspended' where id = $1", [id]);
  expect(await as("worker_rw", (tx) => readPoolAccountRef(tx, account.aws_account_id))).toBeNull();
  expect(await as("worker_rw", (tx) => readPoolAccountRef(tx, "000000000000"))).toBeNull();
  expect(await as("worker_rw", (tx) => readPoolAccountRef(tx, "not an id"))).toBeNull();
});
