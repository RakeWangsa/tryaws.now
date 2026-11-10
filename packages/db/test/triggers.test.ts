import { v7 as uuidv7 } from "uuid";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, inTransaction, insertRow } from "./sql";
import {
  APPEND_ONLY_TABLES,
  type AppendOnlyTable,
  appendOnlyRow,
  newCustomer,
  newLedgerAccount,
  newResource,
  postLedger,
  systemAccount,
  uniqueSuffix,
} from "./fixtures";

const t = useTempDatabase();

it.each(APPEND_ONLY_TABLES)("R5: even the owner cannot UPDATE or DELETE %s", async (table) => {
  const id = await appendOnlyRow(t.pool, table);
  await expectSqlError(
    t.pool.query(`update ${table} set created_at = created_at where id = $1`, [id]),
    "23001",
    { message: new RegExp(`^R5: ${table} is append-only$`) },
  );
  await expectSqlError(t.pool.query(`delete from ${table} where id = $1`, [id]), "23001", {
    message: new RegExp(`^R5: ${table} is append-only$`),
  });
  expect(
    (await t.pool.query(`select count(*)::int as n from ${table} where id = $1`, [id])).rows[0].n,
  ).toBe(1);
});

it.each(["ledger_entries", "audit_log", "legal_acceptances", "fx_rates", "pricing_rules"])(
  "R5: even the owner cannot TRUNCATE %s",
  async (table) => {
    await appendOnlyRow(t.pool, table as AppendOnlyTable);
    await expectSqlError(t.pool.query(`truncate ${table}`), "23001", {
      message: /^R5: .* is append-only$/,
    });
  },
);

it("R5: TRUNCATE ledger_transactions CASCADE is refused too", async () => {
  await appendOnlyRow(t.pool, "ledger_transactions");
  await expectSqlError(t.pool.query("truncate ledger_transactions cascade"), "23001", {
    message: /^R5: .* is append-only$/,
  });
});

it("R13: needs_approval never changes after the row is created, not even for the owner (ruling 6)", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const flagged = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "destroy",
    state: "needs_approval",
    needs_approval: true,
    idempotency_key: uniqueSuffix(),
  });
  const plain = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "reboot",
    idempotency_key: uniqueSuffix(),
  });
  const fixed = { message: /^R13: operations\.needs_approval cannot change$/ };
  await expectSqlError(
    t.pool.query("update operations set needs_approval = false where id = $1", [flagged]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("update operations set needs_approval = true where id = $1", [plain]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("update operations set needs_approval = false, state = 'queued' where id = $1", [
      flagged,
    ]),
    "23001",
    fixed,
  );
  const same = await t.pool.query(
    "update operations set needs_approval = needs_approval, attempts = 1 where id = $1",
    [flagged],
  );
  expect(same.rowCount).toBe(1);
  const { rows } = await t.pool.query(
    "select needs_approval from operations where id = any($1) order by needs_approval",
    [[plain, flagged]],
  );
  expect(rows.map((r) => r.needs_approval)).toEqual([false, true]);
});

describe("ledger balance", () => {
  let wallet: string,
    clearing: string,
    revenue: string,
    korea: string,
    bd: string,
    fee: string,
    usd: string;
  beforeAll(async () => {
    const c = await newCustomer(t.pool);
    wallet = await newLedgerAccount(t.pool, "customer_wallet", c);
    clearing = await systemAccount(t.pool, "gateway_clearing");
    revenue = await systemAccount(t.pool, "revenue_aws_base");
    korea = await systemAccount(t.pool, "vat_korea_payable");
    bd = await systemAccount(t.pool, "vat_bd_payable");
    fee = await systemAccount(t.pool, "processing_fee_income");
    usd = await systemAccount(t.pool, "gateway_clearing", "USD");
  });
  const count = async (id: string) =>
    (await t.pool.query("select count(*)::int as n from ledger_transactions where id = $1", [id]))
      .rows[0].n;

  it("commits a balanced top-up whose lines arrive in two statements", async () => {
    const id = await inTransaction(t.pool, (c) =>
      postLedger(c, "topup:p1", [
        [clearing, "debit", 150000],
        [wallet, "credit", 150000],
      ]),
    );
    expect(await count(id)).toBe(1);
  });

  it("commits the section 8 purchase of 5 USD at FX 127", async () => {
    const id = await inTransaction(t.pool, (c) =>
      postLedger(c, "order:v5", [
        [wallet, "debit", 74295],
        [revenue, "credit", 63500],
        [korea, "credit", 6350],
        [bd, "credit", 3175],
        [fee, "credit", 1270],
      ]),
    );
    expect(await count(id)).toBe(1);
    const { rows } = await t.pool.query(
      "select count(*)::int as n, sum(amount_minor) filter (where direction = 'credit')::int8::text as credits from ledger_entries where transaction_id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ n: 5, credits: "74295" });
  });

  it.each<
    [
      string,
      [string, "debit" | "credit", number][] | (() => [string, "debit" | "credit", number][]),
    ]
  >([
    [
      "debits above credits by one paisa",
      () => [
        [clearing, "debit", 150000],
        [wallet, "credit", 149999],
      ],
    ],
    ["a debit only", () => [[clearing, "debit", 150000]]],
    ["no lines at all", []],
    [
      "lines that balance only across currencies",
      () => [
        [usd, "debit", 100],
        [wallet, "credit", 100],
      ],
    ],
  ])("refuses at commit: %s, and nothing stays", async (_, lines) => {
    const key = "bad:" + uniqueSuffix();
    await expectSqlError(
      inTransaction(t.pool, (c) =>
        postLedger(c, key, typeof lines === "function" ? lines() : lines),
      ),
      "23514",
      { message: /^ledger transaction [0-9a-f-]{36} is not balanced$/ },
    );
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from ledger_transactions where idempotency_key = $1",
          [key],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("refuses a later line that unbalances a committed transaction", async () => {
    const id = await inTransaction(t.pool, (c) =>
      postLedger(c, "topup:p2", [
        [clearing, "debit", 1000],
        [wallet, "credit", 1000],
      ]),
    );
    await expectSqlError(
      inTransaction(t.pool, (c) =>
        c.query(
          "insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor) values ($1, $2, $3, 'debit', 1)",
          [uuidv7(), id, clearing],
        ),
      ),
      "23514",
      { message: /is not balanced$/ },
    );
  });
});
