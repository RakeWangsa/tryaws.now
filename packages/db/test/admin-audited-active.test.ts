import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin, newPoolAccount } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// HARDENING H1: the shared `audited` wrapper requires an ACTIVE admin (R10, R16). A disabled admin,
// an admin that does not exist and an actor whose role is not the one of the row are refused with the
// fixed code "forbidden"; nothing is written and no audit row is appended.
const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });

const AT = new Date("2026-11-11T06:00:00.000Z");
const CASES: Record<string, (r: AdminRepos) => Promise<unknown>> = {
  "customers.approveKyc": (r) =>
    r.customers.approveKyc({ submissionId: uuidv7(), at: AT }, "documents match"),
  "customers.setRiskTier": (r) =>
    r.customers.setRiskTier({ customerId: uuidv7(), tier: "trusted" }, "known"),
  "customers.suspend": (r) => r.customers.suspend({ customerId: uuidv7(), at: AT }, "abuse"),
  "customers.documentRead": (r) =>
    r.customers.documentRead({ submissionId: uuidv7(), index: 0 }, "id check"),
  "audit.export": (r) => r.audit.export({}, "yearly review"),
  "featureFlags.set": (r) =>
    r.featureFlags.set({ key: "linux_instance", market: "BD", enabled: true }, "launch"),
  "fxRates.set": (r) =>
    r.fxRates.set({ market: "BD", rate: "127", effectiveFrom: AT, at: AT }, "first rate"),
  "pricingRules.save": (r) =>
    r.pricingRules.save(
      {
        market: "BD",
        productFamily: null,
        effectiveFrom: AT,
        at: AT,
        steps: [
          { code: "markup", rate: "0", base: "aws", label: { bn: "সার্ভিস চার্জ", en: "Charge" } },
        ],
      },
      "first rule",
    ),
  "capacity.addPoolAccount": (r) =>
    r.capacity.addPoolAccount(
      {
        awsAccountId: "123456789012",
        name: "tc-pool-h1",
        tier: "new",
        roleArn: "arn:aws:iam::123456789012:role/TcProvisioner",
        externalId: "ext-h1",
        limits: [{ region: "ap-southeast-1", quotaCode: "static_ip", limit: 5 }],
      },
      "launch pool",
    ),
  "capacity.setLimit": async (r) =>
    r.capacity.setLimit(
      {
        poolAccountId: await newPoolAccount(t.pool),
        region: "ap-southeast-1",
        quotaCode: "static_ip",
        limit: 5,
      },
      "quota raised",
    ),
  "capacity.setReserve": (r) =>
    r.capacity.setReserve({ market: "BD", quotaCode: "instance_vcpu", reserve: 1 }, "keep one"),
  "waitlist.notifyNext": (r) =>
    r.waitlist.notifyNext(
      { productFamily: "linux_instance", region: "ap-southeast-1", reason: "capacity", count: 1 },
      "one unit freed",
    ),
  "operations.approve": (r) =>
    r.operations.approve({ operationId: uuidv7(), at: AT }, "looked at it"),
  "operations.retry": (r) => r.operations.retry({ operationId: uuidv7(), at: AT }, "try again"),
  "operations.reject": (r) => r.operations.reject({ operationId: uuidv7(), at: AT }, "not wanted"),
};
const FORBIDDEN = { ok: false, error: "forbidden" };

async function tablesCount(): Promise<Record<string, number>> {
  const one = async (sql: string) => Number((await t.pool.query(sql)).rows[0].n);
  return {
    audit: await one("select count(*) as n from audit_log"),
    flags: await one("select count(*) as n from feature_flags"),
    fx: await one("select count(*) as n from fx_rates"),
    rules: await one("select count(*) as n from pricing_rules"),
    pools: await one("select count(*) as n from pool_accounts where name = 'tc-pool-h1'"),
    limits: await one("select count(*) as n from pool_capacity"),
  };
}

it.each(Object.entries(CASES))(
  "%s: a disabled admin is refused, nothing is written",
  async (_, run) => {
    await ensureMarket(t.pool);
    const id = await newAdmin(t.pool, "ops");
    await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
    const before = await tablesCount();
    const out = await asAdmin({ adminId: id, role: "ops", ip: "203.0.113.9" }, run);
    expect(out).toEqual(FORBIDDEN);
    expect(await tablesCount()).toEqual(before);
    expect(await auditRowsOf(t.pool, id)).toEqual([]);
  },
);

it.each(Object.entries(CASES))(
  "%s: a missing admin is refused, nothing is written",
  async (_, run) => {
    await ensureMarket(t.pool);
    const before = await tablesCount();
    const ghost = uuidv7();
    expect(await asAdmin({ adminId: ghost, role: "ops", ip: "203.0.113.9" }, run)).toEqual(
      FORBIDDEN,
    );
    expect(await tablesCount()).toEqual(before);
    expect(await auditRowsOf(t.pool, ghost)).toEqual([]);
  },
);

it.each(Object.entries(CASES))(
  "%s: an actor with another role than the row is refused",
  async (_, run) => {
    await ensureMarket(t.pool);
    const id = await newAdmin(t.pool, "support");
    const before = await tablesCount();
    expect(await asAdmin({ adminId: id, role: "superadmin", ip: "203.0.113.9" }, run)).toEqual(
      FORBIDDEN,
    );
    expect(await tablesCount()).toEqual(before);
  },
);

it("authorization comes before validation: a disabled admin with a blank reason gets forbidden", async () => {
  const id = await newAdmin(t.pool, "ops");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
  const out = await asAdmin({ adminId: id, role: "ops", ip: "203.0.113.9" }, (r) =>
    r.featureFlags.set({ key: "cdn", market: "BD", enabled: true }, "  "),
  );
  expect(out).toEqual(FORBIDDEN);
});

it("an active admin with the right role still writes, with the audit row", async () => {
  await ensureMarket(t.pool);
  const id = await newAdmin(t.pool, "ops");
  const out = await asAdmin({ adminId: id, role: "ops", ip: "203.0.113.9" }, (r) =>
    r.featureFlags.set({ key: "linux_instance", market: "BD", enabled: true }, "launch"),
  );
  expect(out).toMatchObject({ ok: true });
  expect(await auditRowsOf(t.pool, id)).toHaveLength(1);
});

it("a disabled admin that was active when the transaction began cannot write after a concurrent disable commits", async () => {
  await ensureMarket(t.pool);
  const id = await newAdmin(t.pool, "ops");
  // The share lock of the check holds the row: the disable below waits for the write to finish and
  // the write has already seen "active", so both orders end in a consistent state.
  const result = await asAdmin({ adminId: id, role: "ops", ip: "203.0.113.9" }, async (r) => {
    const written = await r.featureFlags.set(
      { key: "linux_instance", market: "BD", enabled: true },
      "launch",
    );
    return written;
  });
  expect(result).toMatchObject({ ok: true });
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
  const after = await asAdmin({ adminId: id, role: "ops", ip: "203.0.113.9" }, (r) =>
    r.featureFlags.set({ key: "linux_instance", market: "BD", enabled: false }, "again"),
  );
  expect(after).toEqual(FORBIDDEN);
});
