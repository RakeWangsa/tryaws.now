import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { DbError } from "../errors";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { runTransaction } from "../tx";
import { testPoster, testReverser } from "./admin-money-support";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WP9-T2 sweep, admin side (R10, R16, HARDENING H1). EVERY method of adminRepos, a read or a write,
// begins with the active-admin check and the role check of its area. The table below has one call
// for every method (the arguments are the right shape and mean nothing: a gate answers before any
// work). The completeness test fails when a method of adminRepos is not in the table, so a new
// admin read cannot ship without its gate case.
//   - a disabled admin, an admin that does not exist and an actor whose role is not the row's are
//     refused;
//   - an active admin of a role that the area does not serve is refused (`deny`);
//   - a refusal is `{ ok: false, error: "forbidden" }`; the three raw reads (`raw`) throw DbError 42501;
//   - nothing is written: no audit row and no row in the tables of the writes.
const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });

const AT = new Date("2030-01-01T00:00:00.000Z");
const ID = () => uuidv7();
type Call = (r: AdminRepos) => Promise<unknown>;
interface GateCase {
  readonly call: Call;
  /** An active admin of this role is refused by the area (null: the area is open to every admin). */
  readonly deny: AdminActor["role"] | null;
  /** A raw read: a refusal throws a DbError (42501) instead of answering { ok: false }. */
  readonly raw?: true;
}

const NOTIFY = {
  productFamily: "linux_instance",
  region: "ap-southeast-1",
  reason: "capacity",
  count: 1,
} as const;

const GATE_CASES: Record<string, GateCase> = {
  "adminUsers.list": { call: (r) => r.adminUsers.list(), deny: "ops" },
  "adminUsers.detail": { call: (r) => r.adminUsers.detail(ID()), deny: "ops" },
  "adminUsers.create": {
    call: (r) => r.adminUsers.create({ cognitoSub: "s-" + ID(), role: "support" }, "r"),
    deny: "ops",
  },
  "adminUsers.setRole": {
    call: (r) => r.adminUsers.setRole({ adminId: ID(), role: "ops" }, "r"),
    deny: "ops",
  },
  "adminUsers.disable": { call: (r) => r.adminUsers.disable({ adminId: ID() }, "r"), deny: "ops" },
  "adminUsers.enable": { call: (r) => r.adminUsers.enable({ adminId: ID() }, "r"), deny: "ops" },
  "adminUsers.recordDirectoryAction": {
    call: (r) => r.adminUsers.recordDirectoryAction({ adminId: ID(), kind: "mfa_reset" }, "r"),
    deny: "ops",
  },
  "audit.search": { call: (r) => r.audit.search(), deny: null },
  "audit.detail": { call: (r) => r.audit.detail(ID()), deny: null },
  "audit.export": { call: (r) => r.audit.export(), deny: "ops" },
  "abuse.list": { call: (r) => r.abuse.list({} as never), deny: "finance" },
  "abuse.detail": { call: (r) => r.abuse.detail(ID()), deny: "finance" },
  "abuse.open": {
    call: (r) =>
      r.abuse.open({ caseId: ID(), resourceId: ID(), source: "monitoring" } as never, "r"),
    deny: "finance",
  },
  "abuse.addNote": {
    call: (r) => r.abuse.addNote({ caseId: ID(), noteId: ID(), note: "n", at: AT }, "r"),
    deny: "finance",
  },
  "abuse.close": {
    call: (r) => r.abuse.close({ caseId: ID(), at: AT }, "r"),
    deny: "finance",
  },
  "abuse.suspendResource": {
    call: (r) => r.abuse.suspendResource({ caseId: ID(), at: AT }, "r"),
    deny: "support",
  },
  "reconciliation.overview": { call: (r) => r.reconciliation.overview(), deny: "support" },
  "reconciliation.list": {
    call: (r) => r.reconciliation.list({} as never),
    deny: "support",
  },
  "support.list": { call: (r) => r.support.list({} as never), deny: "finance" },
  "support.detail": { call: (r) => r.support.detail(ID()), deny: "finance" },
  "support.reply": {
    call: (r) => r.support.reply({ requestId: ID(), replyId: ID(), body: "b" }, "r"),
    deny: "finance",
  },
  "support.close": { call: (r) => r.support.close({ requestId: ID() }, "r"), deny: "finance" },
  "capacity.pending": {
    call: (r) =>
      r.capacity.pending({
        poolAccountId: ID(),
        region: "ap-southeast-1",
        quotaCode: "static_ip",
      } as never),
    deny: "support",
  },
  "capacity.overview": { call: (r) => r.capacity.overview("BD"), deny: "support" },
  "capacity.list": { call: (r) => r.capacity.list("BD"), deny: "support", raw: true },
  "capacity.addPoolAccount": {
    call: (r) =>
      r.capacity.addPoolAccount(
        {
          awsAccountId: "123456789012",
          name: "tc-pool-gate",
          tier: "new",
          roleArn: "arn:aws:iam::123456789012:role/TcProvisioner",
          externalId: "ext-gate",
          limits: [{ region: "ap-southeast-1", quotaCode: "static_ip", limit: 5 }],
        },
        "r",
      ),
    deny: null,
  },
  "capacity.setLimit": {
    call: (r) =>
      r.capacity.setLimit(
        { poolAccountId: ID(), region: "ap-southeast-1", quotaCode: "static_ip", limit: 5 },
        "r",
      ),
    deny: null,
  },
  "capacity.setReserve": {
    call: (r) =>
      r.capacity.setReserve({ market: "BD", quotaCode: "instance_vcpu", reserve: 1 }, "r"),
    deny: null,
  },
  "customers.search": { call: (r) => r.customers.search({} as never), deny: "finance" },
  "customers.detail": { call: (r) => r.customers.detail(ID()), deny: "finance" },
  "customers.kycQueue": { call: (r) => r.customers.kycQueue(), deny: "finance" },
  "customers.approveKyc": {
    call: (r) => r.customers.approveKyc({ submissionId: ID(), at: AT }, "r"),
    deny: "support",
  },
  "customers.rejectKyc": {
    call: (r) => r.customers.rejectKyc({ submissionId: ID(), at: AT }, "r"),
    deny: "support",
  },
  "customers.setRiskTier": {
    call: (r) => r.customers.setRiskTier({ customerId: ID(), tier: "trusted" }, "r"),
    deny: "support",
  },
  "customers.suspend": {
    call: (r) => r.customers.suspend({ customerId: ID(), at: AT }, "r"),
    deny: "support",
  },
  "customers.resume": {
    call: (r) => r.customers.resume({ customerId: ID(), at: AT }, "r"),
    deny: "support",
  },
  "customers.documentRead": {
    call: (r) => r.customers.documentRead({ submissionId: ID(), index: 0 }),
    deny: "finance",
  },
  "featureFlags.set": {
    call: (r) => r.featureFlags.set({ key: "linux_instance", market: "BD", enabled: true }, "r"),
    deny: null,
  },
  "fxChanges.read": { call: (r) => r.fxChanges.read("BD"), deny: null, raw: true },
  "fxChanges.request": {
    call: (r) =>
      r.fxChanges.request(
        { market: "BD", rate: "150", effectiveFrom: null, at: AT, expiresAt: new Date(+AT + 1e6) },
        "r",
      ),
    deny: null,
  },
  "fxChanges.approve": {
    call: (r) => r.fxChanges.approve({ market: "BD", at: AT }, "r"),
    deny: null,
  },
  "fxRates.set": {
    call: (r) => r.fxRates.set({ market: "BD", rate: "127", effectiveFrom: AT, at: AT }, "r"),
    deny: null,
  },
  "pricingRules.save": {
    call: (r) =>
      r.pricingRules.save(
        {
          market: "BD",
          productFamily: null,
          effectiveFrom: AT,
          at: AT,
          steps: [{ code: "markup", rate: "0", base: "aws", label: { bn: "চার্জ", en: "Charge" } }],
        },
        "r",
      ),
    deny: null,
  },
  "blueprints.list": { call: (r) => r.blueprints.list("BD"), deny: "finance" },
  "blueprints.setEnabled": {
    call: (r) =>
      r.blueprints.setEnabled({ market: "BD", blueprintId: "some_image", enabled: true }, "r"),
    deny: "finance",
  },
  "blueprints.setMinPower": {
    call: (r) =>
      r.blueprints.setMinPower({ market: "BD", blueprintId: "some_image", minPower: 500 }, "r"),
    deny: "finance",
  },
  "configPrices.read": { call: (r) => r.configPrices.read("BD"), deny: "support" },
  "configPrices.save": {
    call: (r) =>
      r.configPrices.save(
        {
          market: "BD",
          key: "config_price.load_balancer_month",
          usd: "18",
          effectiveFrom: AT,
          at: AT,
        },
        "r",
      ),
    deny: "support",
  },
  "invoiceSeller.read": { call: (r) => r.invoiceSeller.read("BD"), deny: "ops" },
  "invoiceSeller.save": {
    call: (r) =>
      r.invoiceSeller.save(
        {
          market: "BD",
          seller: {
            legalNameBn: "ক",
            legalNameEn: "A",
            bin: "0000000000000",
            addressBn: "ক",
            addressEn: "A",
            signatoryName: "A",
            signatoryDesignation: "A",
          },
        },
        "r",
      ),
    deny: "ops",
  },
  "tierLimits.read": { call: (r) => r.tierLimits.read("BD"), deny: "finance" },
  "tierLimits.save": {
    call: (r) =>
      r.tierLimits.save(
        {
          market: "BD",
          tier: "new",
          limits: {
            maxInstances: 5,
            maxBundleUsd: "24",
            windows: false,
            containers: false,
            maxStaticIps: 1,
          },
        },
        "r",
      ),
    deny: "finance",
  },
  "priceBook.read": { call: (r) => r.priceBook.read("BD"), deny: "support" },
  "priceBook.save": {
    call: (r) =>
      r.priceBook.save(
        {
          market: "BD",
          family: "linux_instance",
          margin: { kind: "percent", value: "0.1" },
          commission: null,
          effectiveFrom: AT,
          at: AT,
        },
        "r",
      ),
    deny: "support",
  },
  "priceBook.setBaseCost": {
    call: (r) => r.priceBook.setBaseCost({ catalogProductId: ID(), awsPriceUsd: "0.2" }, "r"),
    deny: "support",
  },
  "operations.queue": { call: (r) => r.operations.queue(), deny: "finance" },
  "operations.counts": { call: (r) => r.operations.counts(), deny: "finance" },
  "operations.detail": { call: (r) => r.operations.detail(ID()), deny: "finance" },
  "operations.planChange": { call: (r) => r.operations.planChange(ID()), deny: "finance" },
  "operations.clearPlanChangeMark": {
    call: (r) =>
      r.operations.clearPlanChangeMark({ resourceId: ID(), requestId: ID(), at: AT }, "r"),
    deny: "finance",
  },
  "operations.approve": {
    call: (r) => r.operations.approve({ operationId: ID(), at: AT }, "r"),
    deny: "finance",
  },
  "operations.retry": {
    call: (r) => r.operations.retry({ operationId: ID(), at: AT }, "r"),
    deny: "finance",
  },
  "operations.reject": {
    call: (r) => r.operations.reject({ operationId: ID(), at: AT }, "r"),
    deny: "finance",
  },
  "payments.search": { call: (r) => r.payments.search({} as never), deny: "support" },
  "payments.detail": { call: (r) => r.payments.detail(ID()), deny: "support" },
  "payments.reverify": {
    call: (r) => r.payments.reverify({ paymentId: ID() }, "r"),
    deny: "support",
  },
  "payments.recordManualRefund": {
    call: (r) =>
      r.payments.recordManualRefund({ paymentId: ID(), amountMinor: 1n }, "r", testPoster),
    deny: "support",
  },
  "payments.discrepancies": { call: (r) => r.payments.discrepancies(), deny: "support" },
  "payments.resolveDiscrepancy": {
    call: (r) => r.payments.resolveDiscrepancy({ id: ID() }, "r"),
    deny: "support",
  },
  "waitlist.counts": { call: (r) => r.waitlist.counts(), deny: "support" },
  "waitlist.list": { call: (r) => r.waitlist.list(), deny: "support", raw: true },
  "waitlist.notifyNext": { call: (r) => r.waitlist.notifyNext(NOTIFY, "r"), deny: "support" },
  "wallets.detail": { call: (r) => r.wallets.detail(ID()), deny: "support" },
  "wallets.createAdjustment": {
    call: (r) =>
      r.wallets.createAdjustment(
        {
          requestId: ID(),
          at: AT,
          customerId: ID(),
          direction: "credit",
          amountMinor: 100n,
          kind: "deposit",
        },
        "r",
        testPoster,
      ),
    deny: "superadmin",
  },
  "wallets.approveAdjustment": {
    call: (r) => r.wallets.approveAdjustment({ id: ID() }, "r", testPoster),
    deny: "support",
  },
  "wallets.creditWalletForFailedChange": {
    call: (r) =>
      r.wallets.creditWalletForFailedChange(
        { operationId: ID(), at: new Date() },
        "r",
        testReverser,
      ),
    deny: "support",
  },
  "wallets.rejectAdjustment": {
    call: (r) => r.wallets.rejectAdjustment({ id: ID() }, "r"),
    deny: "support",
  },
};

const FORBIDDEN = { ok: false, error: "forbidden" };

async function counts(): Promise<Record<string, number>> {
  const n = async (table: string) =>
    Number((await t.pool.query(`select count(*) as n from ${table}`)).rows[0].n);
  const tables = [
    "audit_log",
    "admin_users",
    "feature_flags",
    "fx_rates",
    "pricing_rules",
    "pool_accounts",
    "pool_capacity",
    "settings",
    "wallet_adjustments",
    "discrepancies",
  ];
  return Object.fromEntries(await Promise.all(tables.map(async (x) => [x, await n(x)])));
}

async function refused(actor: AdminActor, entry: GateCase): Promise<void> {
  const before = await counts();
  if (entry.raw === true) {
    const error: unknown = await asAdmin(actor, entry.call).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("42501");
  } else {
    expect(await asAdmin(actor, entry.call)).toEqual(FORBIDDEN);
  }
  expect(await counts()).toEqual(before);
}

const ROWS = Object.entries(GATE_CASES);

it("every method of adminRepos, a read or a write, has a gate case", () => {
  const repos = adminRepos({} as Tx, { adminId: uuidv7(), role: "ops", ip: "203.0.113.9" });
  const methods = Object.entries(repos)
    .flatMap(([name, repo]) => Object.keys(repo).map((m) => `${name}.${m}`))
    .sort();
  expect(Object.keys(GATE_CASES).sort()).toEqual(methods);
});

it.each(ROWS)("%s: a disabled admin is refused and gets or writes nothing", async (name, entry) => {
  await ensureMarket(t.pool);
  const role = entry.deny ?? "ops";
  const id = await newAdmin(t.pool, role);
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
  await refused({ adminId: id, role, ip: "203.0.113.9" }, entry);
  expect(name).toBeTruthy();
});

it.each(ROWS)("%s: an admin that does not exist is refused", async (_name, entry) => {
  await ensureMarket(t.pool);
  await refused({ adminId: uuidv7(), role: entry.deny ?? "ops", ip: "203.0.113.9" }, entry);
});

it.each(ROWS)("%s: an actor with a role that is not the row's is refused", async (_name, entry) => {
  await ensureMarket(t.pool);
  // The row is a support admin; the actor claims superadmin (which every area serves).
  const id = await newAdmin(t.pool, "support");
  await refused({ adminId: id, role: "superadmin", ip: "203.0.113.9" }, entry);
});

it.each(ROWS.filter(([, entry]) => entry.deny !== null))(
  "%s: an active admin of a role that the area does not serve is refused",
  async (_name, entry) => {
    await ensureMarket(t.pool);
    const role = entry.deny as AdminActor["role"];
    const id = await newAdmin(t.pool, role);
    await refused({ adminId: id, role, ip: "203.0.113.9" }, entry);
  },
);
