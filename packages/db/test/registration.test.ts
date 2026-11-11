import { expect, it, vi } from "vitest";
import type { Tx } from "../client";
import { lookupCustomerBySub } from "../repositories/identity";
import { registerCustomer, type NewCustomer } from "../repositories/system/registration";
import { runTransaction } from "../tx";
import { ensureMarket, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// The injected failure: a stand-in for insertAudit that throws when the flag is on.
const audit = vi.hoisted(() => ({ fail: false }));
vi.mock("../repositories/audit-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/audit-log")>();
  return {
    ...actual,
    insertAudit: async (...args: Parameters<typeof actual.insertAudit>) => {
      if (audit.fail) throw new Error("injected audit failure");
      return actual.insertAudit(...args);
    },
  };
});

const t = useTempDatabase();
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });

const acceptances = [
  { document: "terms", version: "2026-11-draft" },
  { document: "acceptable_use", version: "2026-11-draft" },
  { document: "privacy", version: "2026-11-draft" },
] as const;

const input = (over: Partial<NewCustomer> = {}): NewCustomer => ({
  cognitoSub: "sub-" + uniqueSuffix(),
  email: "rahim." + uniqueSuffix() + "@example.test",
  phone: "+8801712345678",
  name: "Rahim Uddin",
  market: "BD",
  locale: "bn",
  acceptances: [...acceptances],
  ip: "203.0.113.7",
  userAgent: "test-agent/1.0",
  ...over,
});

const count = async (table: string, where = "true", params: unknown[] = []): Promise<number> =>
  Number(
    (await t.pool.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0]
      .n,
  );
const counts = async (customerId: string) => ({
  customers: await count("customers", "id = $1", [customerId]),
  wallets: await count("wallets", "customer_id = $1", [customerId]),
  accounts: await count("ledger_accounts", "customer_id = $1", [customerId]),
  acceptances: await count("legal_acceptances", "customer_id = $1", [customerId]),
  audit: await count("audit_log", "actor_id = $1", [customerId]),
});
const totals = async () => ({
  customers: await count("customers"),
  wallets: await count("wallets"),
  accounts: await count("ledger_accounts"),
  acceptances: await count("legal_acceptances"),
  audit: await count("audit_log"),
});

it("creates the customer, a wallet, its ledger account, three acceptances and one audit row", async () => {
  await ensureMarket(t.pool);
  const i = input();
  const r = await asWeb((tx) => registerCustomer(tx, i));
  expect(r).toMatchObject({ ok: true, replayed: false });
  if (!r.ok) return;
  const customer = (await t.pool.query("select * from customers where id = $1", [r.customerId]))
    .rows[0];
  expect(customer).toMatchObject({
    cognito_sub: i.cognitoSub,
    email: i.email,
    phone: "+8801712345678",
    name: "Rahim Uddin",
    type: "individual",
    market: "BD",
    locale: "bn",
    status: "active",
    kyc_status: "none",
    risk_tier: "new",
    phone_verified_at: null,
  });
  expect(
    (
      await t.pool.query(
        "select balance_minor::text, currency from wallets where customer_id = $1",
        [r.customerId],
      )
    ).rows,
  ).toEqual([{ balance_minor: "0", currency: "BDT" }]);
  expect(
    (
      await t.pool.query("select type, currency from ledger_accounts where customer_id = $1", [
        r.customerId,
      ])
    ).rows,
  ).toEqual([{ type: "customer_wallet", currency: "BDT" }]);
  const accepted = (
    await t.pool.query(
      "select document, version, host(ip) as ip from legal_acceptances where customer_id = $1 order by document",
      [r.customerId],
    )
  ).rows;
  expect(accepted).toEqual([
    { document: "acceptable_use", version: "2026-11-draft", ip: "203.0.113.7" },
    { document: "privacy", version: "2026-11-draft", ip: "203.0.113.7" },
    { document: "terms", version: "2026-11-draft", ip: "203.0.113.7" },
  ]);
  const audits = (await t.pool.query("select * from audit_log where actor_id = $1", [r.customerId]))
    .rows;
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_type: "customer",
    action: "customer.register",
    target_type: "customer",
    target_id: r.customerId,
    user_agent: "test-agent/1.0",
    metadata: { market: "BD", type: "individual" },
  });
});

it("the audit metadata holds neither the email, the phone nor the name", async () => {
  const i = input({ name: "Zxqvname Plantedperson", email: "planted.zxq@example.test" });
  const r = await asWeb((tx) => registerCustomer(tx, i));
  if (!r.ok) throw new Error("not registered");
  const row = (
    await t.pool.query("select metadata::text as m from audit_log where actor_id = $1", [
      r.customerId,
    ])
  ).rows[0];
  for (const planted of [
    "Zxqvname",
    "Plantedperson",
    "planted.zxq",
    "+8801712345678",
    "8801712345678",
  ]) {
    expect(row.m).not.toContain(planted);
  }
});

it("the same call again is a replay: same id, nothing added", async () => {
  const i = input();
  const first = await asWeb((tx) => registerCustomer(tx, i));
  if (!first.ok) throw new Error("not registered");
  const before = await counts(first.customerId);
  expect(before).toEqual({ customers: 1, wallets: 1, accounts: 1, acceptances: 3, audit: 1 });
  const again = await asWeb((tx) => registerCustomer(tx, i));
  expect(again).toEqual({ ok: true, customerId: first.customerId, replayed: true });
  expect(await counts(first.customerId)).toEqual(before);
});

it("a replay after the wallet and its account were lost repairs both", async () => {
  const i = input();
  const first = await asWeb((tx) => registerCustomer(tx, i));
  if (!first.ok) throw new Error("not registered");
  await t.pool.query("delete from wallets where customer_id = $1", [first.customerId]);
  await t.pool.query("delete from ledger_accounts where customer_id = $1", [first.customerId]);
  const again = await asWeb((tx) => registerCustomer(tx, i));
  expect(again).toMatchObject({ ok: true, replayed: true });
  expect(await counts(first.customerId)).toEqual({
    customers: 1,
    wallets: 1,
    accounts: 1,
    acceptances: 3,
    audit: 1,
  });
});

it.each<[string, Partial<NewCustomer>]>([
  ["a sub of 129 characters", { cognitoSub: "s".repeat(129) }],
  ["an empty sub", { cognitoSub: "" }],
  ["a phone that is not canonical", { phone: "01712345678" }],
  ["a locale of fr", { locale: "fr" as never }],
  ["an ip that is not an address", { ip: "not-an-ip" }],
  ["an ip with a mask", { ip: "203.0.113.7/24" }],
  ["a name of one character", { name: "A" }],
  ["an email without an at sign", { email: "nope" }],
  ["a user agent of 257 characters", { userAgent: "u".repeat(257) }],
  ["two acceptances", { acceptances: acceptances.slice(0, 2) }],
  [
    "a duplicate document",
    {
      acceptances: [acceptances[0], acceptances[0], acceptances[1]],
    },
  ],
  [
    "a fourth document",
    {
      acceptances: [...acceptances, { document: "refund" as never, version: "v1" }],
    },
  ],
  [
    "a document that is not one of the three",
    {
      acceptances: [acceptances[0], acceptances[1], { document: "refund" as never, version: "v1" }],
    },
  ],
  [
    "an empty version",
    {
      acceptances: [acceptances[0], acceptances[1], { document: "privacy", version: "" }],
    },
  ],
  ["a market that is not a code", { market: "bd" }],
])("%s is a validation error and writes nothing", async (_name, over) => {
  await ensureMarket(t.pool);
  const before = await totals();
  const r = await asWeb((tx) => registerCustomer(tx, input(over)));
  expect(r).toEqual({ ok: false, error: "validation" });
  expect(await totals()).toEqual(before);
});

it("an unknown market and an inactive market are market_unavailable and write nothing", async () => {
  await ensureMarket(t.pool);
  await ensureMarket(t.pool, "XX");
  await t.pool.query("update markets set active = false where code = 'XX'");
  const before = await totals();
  for (const market of ["ZZ", "XX"]) {
    expect(await asWeb((tx) => registerCustomer(tx, input({ market })))).toEqual({
      ok: false,
      error: "market_unavailable",
    });
  }
  expect(await totals()).toEqual(before);
});

it("a failure after the wallet and before the audit row rolls everything back", async () => {
  const i = input();
  const before = await totals();
  audit.fail = true;
  try {
    await expect(asWeb((tx) => registerCustomer(tx, i))).rejects.toThrow();
  } finally {
    audit.fail = false;
  }
  expect(await totals()).toEqual(before);
  expect(await count("customers", "cognito_sub = $1", [i.cognitoSub])).toBe(0);
});

it("lookupCustomerBySub finds the new customer", async () => {
  const i = input();
  const r = await asWeb((tx) => registerCustomer(tx, i));
  if (!r.ok) throw new Error("not registered");
  const found = await asWeb((tx) => lookupCustomerBySub(tx, i.cognitoSub));
  expect(found).toMatchObject({ id: r.customerId, status: "active", locale: "bn" });
});

it("two customers with the same email and different subs both register (Cognito owns uniqueness)", async () => {
  const email = "same." + uniqueSuffix() + "@example.test";
  const a = await asWeb((tx) => registerCustomer(tx, input({ email })));
  const b = await asWeb((tx) => registerCustomer(tx, input({ email })));
  expect(a).toMatchObject({ ok: true, replayed: false });
  expect(b).toMatchObject({ ok: true, replayed: false });
  if (a.ok && b.ok) expect(a.customerId).not.toBe(b.customerId);
});
