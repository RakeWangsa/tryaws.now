import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import type { LedgerReverser } from "../repositories/admin/ledger-port";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";
import {
  ensureMarket,
  newAdmin,
  newCustomer,
  newPoolAccount,
  newResource,
  uniqueSuffix,
} from "./fixtures";
import { fundedWallet, newPayment, testPoster } from "./admin-money-support";
import { inTransaction, insertRow } from "./sql";

const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actor = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const auditRows = (actorId: string) => auditRowsOf(t.pool, actorId);
const flag = async (key: string) =>
  (await t.pool.query("select enabled from feature_flags where key = $1 and market = 'BD'", [key]))
    .rows;

const AT = new Date("2030-01-01T00:00:00.000Z");
// An operation of a destroy kind (not a create, which a reject sends through the compensation path).
async function seedOperation(state: string): Promise<string> {
  const resourceId = await newResource(t.pool, await newCustomer(t.pool));
  return insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "reboot",
    state,
    idempotency_key: "a:" + uniqueSuffix(),
    ...(state === "needs_approval" ? { needs_approval: true } : {}),
  });
}

// WPU-M3: a failed apply of a resource whose renewal charge (100 paisa from the wallet) is in the ledger.
async function seedFailedApply(): Promise<string> {
  const w = await fundedWallet(t.pool, 1_000n);
  const resourceId = await newResource(t.pool, w.customerId, { family: "container_service" });
  const end = new Date("2030-02-01T00:00:00.000Z");
  const sub = await insertRow(t.pool, "subscriptions", {
    resource_id: resourceId,
    customer_id: w.customerId,
    term_days: 30,
    price_snapshot: JSON.stringify({}),
    period_start: new Date("2030-01-01T00:00:00.000Z"),
    period_end: new Date("2030-03-03T00:00:00.000Z"),
  });
  const wallet = (
    await t.pool.query(
      "select id from ledger_accounts where type = 'customer_wallet' and customer_id = $1",
      [w.customerId],
    )
  ).rows[0].id as string;
  const revenue = (
    await t.pool.query(
      "select id from ledger_accounts where type = 'gateway_clearing' and customer_id is null",
    )
  ).rows[0].id as string;
  await inTransaction(t.pool, async (c) => {
    const txId = await insertRow(c, "ledger_transactions", {
      kind: "renewal",
      reference_type: "subscription",
      reference_id: sub,
      idempotency_key: `renew:${sub}:${end.toISOString()}`,
      actor_type: "system",
    });
    await insertRow(c, "ledger_entries", {
      transaction_id: txId,
      account_id: wallet,
      direction: "debit",
      amount_minor: 100n,
    });
    await insertRow(c, "ledger_entries", {
      transaction_id: txId,
      account_id: revenue,
      direction: "credit",
      amount_minor: 100n,
    });
  });
  return insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "scale_container",
    state: "needs_attention",
    idempotency_key: "a:" + uniqueSuffix(),
    payload: JSON.stringify({ subscriptionId: sub, periodEnd: end.toISOString() }),
  });
}

// A reverser that says ok (the real one is exercised in packages/core).
const okReverser: LedgerReverser = async () => ({ ok: true, value: { transactionId: uuidv7() } });

async function seedKyc(): Promise<string> {
  return insertRow(t.pool, "kyc_submissions", {
    customer_id: await newCustomer(t.pool, { kyc_status: "pending" }),
    document_type: "nid",
    document_number_encrypted: Buffer.from([1]),
    s3_keys: ["kyc/x/front.jpg"],
  });
}

async function seedAdjustment(): Promise<string> {
  const w = await fundedWallet(t.pool, 0n);
  return insertRow(t.pool, "wallet_adjustments", {
    customer_id: w.customerId,
    direction: "credit",
    amount_minor: 100n,
    kind: "deposit",
    reason: "seed",
    requested_by: await newAdmin(t.pool, "finance"),
  });
}

async function seedReviewPayment(): Promise<string> {
  return (await newPayment(t.pool, await newCustomer(t.pool), { status: "review" })).id;
}

// The money writes are for finance; the discrepancy queue is for ops too.
const roleOf = (name: string): AdminActor["role"] =>
  name.startsWith("adminUsers.")
    ? "superadmin"
    : name.startsWith("support.")
      ? "support"
      : (name.startsWith("wallets.") ||
            name.startsWith("payments.") ||
            name.startsWith("priceBook.") ||
            name.startsWith("configPrices.") ||
            name.startsWith("invoiceSeller.")) &&
          name !== "payments.resolveDiscrepancy"
        ? "finance"
        : "ops";

async function seedAbuseCase(): Promise<string> {
  return insertRow(t.pool, "abuse_cases", {
    resource_id: await newResource(t.pool, await newCustomer(t.pool), { state: "active" }),
    source: "monitoring",
  });
}

async function seedSupportRequest(): Promise<string> {
  return insertRow(t.pool, "support_requests", {
    customer_id: await newCustomer(t.pool),
    category: "billing",
    subject: "Question",
    message: "Hello",
  });
}

// Every write of adminRepos has a case here; the completeness test below fails when one is missing (R10).
const ADMIN_WRITE_CASES: Record<string, (r: AdminRepos) => Promise<unknown>> = {
  "adminUsers.create": (r) =>
    r.adminUsers.create({ cognitoSub: "sub-" + uniqueSuffix(), role: "support" }, "new support"),
  "adminUsers.setRole": async (r) =>
    r.adminUsers.setRole({ adminId: await newAdmin(t.pool, "support"), role: "ops" }, "to ops"),
  "adminUsers.disable": async (r) =>
    r.adminUsers.disable({ adminId: await newAdmin(t.pool, "support") }, "left"),
  "adminUsers.enable": async (r) => {
    const id = await newAdmin(t.pool, "support");
    await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
    return r.adminUsers.enable({ adminId: id }, "back");
  },
  "adminUsers.recordDirectoryAction": async (r) =>
    r.adminUsers.recordDirectoryAction(
      { adminId: await newAdmin(t.pool, "support"), kind: "mfa_reset" },
      "lost phone",
    ),
  "abuse.open": async (r) =>
    r.abuse.open(
      {
        caseId: uuidv7(),
        resourceId: await newResource(t.pool, await newCustomer(t.pool)),
        source: "monitoring",
      },
      "alert",
    ),
  "abuse.addNote": async (r) =>
    r.abuse.addNote(
      { caseId: await seedAbuseCase(), noteId: uuidv7(), note: "called", at: AT },
      "follow-up",
    ),
  "abuse.close": async (r) =>
    r.abuse.close({ caseId: await seedAbuseCase(), at: AT }, "false alarm"),
  "abuse.suspendResource": async (r) =>
    r.abuse.suspendResource({ caseId: await seedAbuseCase(), at: AT }, "spam"),
  "abuse.restoreResource": async (r) =>
    r.abuse.restoreResource(
      {
        caseId: await insertRow(t.pool, "abuse_cases", {
          resource_id: await newResource(t.pool, await newCustomer(t.pool), {
            state: "suspended",
            config: JSON.stringify({ adminSuspended: true }),
          }),
          source: "monitoring",
        }),
        at: AT,
      },
      "false alarm",
    ),
  "support.reply": async (r) =>
    r.support.reply(
      { requestId: await seedSupportRequest(), replyId: uuidv7(), body: "Hello" },
      "reply",
    ),
  "support.close": async (r) =>
    r.support.close({ requestId: await seedSupportRequest() }, "answered"),
  "customers.approveKyc": async (r) =>
    r.customers.approveKyc({ submissionId: await seedKyc(), at: AT }, "documents match"),
  "customers.rejectKyc": async (r) =>
    r.customers.rejectKyc({ submissionId: await seedKyc(), at: AT }, "unreadable"),
  "customers.setRiskTier": async (r) =>
    r.customers.setRiskTier({ customerId: await newCustomer(t.pool), tier: "trusted" }, "known"),
  "customers.suspend": async (r) =>
    r.customers.suspend({ customerId: await newCustomer(t.pool), at: AT }, "abuse"),
  "customers.resume": async (r) =>
    r.customers.resume({ customerId: await newCustomer(t.pool), at: AT }, "cleared"),
  "customers.documentRead": async (r) =>
    r.customers.documentRead({ submissionId: await seedKyc(), index: 0 }),
  "featureFlags.set": (r) =>
    r.featureFlags.set(
      { key: "linux_instance", market: "BD", enabled: true },
      "launch of Linux servers",
    ),
  "fxChanges.request": (r) =>
    r.fxChanges.request(
      {
        market: "BD",
        rate: "150",
        effectiveFrom: null,
        at: AT,
        expiresAt: new Date(AT.getTime() + 86_400_000),
      },
      "bank rate moved",
    ),
  "fxChanges.approve": async (r) => {
    // A change that another admin asked for (a random id), pending at AT.
    const value = JSON.stringify({
      rate: "150",
      effectiveFrom: null,
      reason: "bank rate moved",
      requestedBy: uuidv7(),
      requestedAt: AT.toISOString(),
      expiresAt: new Date(AT.getTime() + 86_400_000).toISOString(),
      status: "pending",
      approvedBy: null,
      approvedAt: null,
    });
    await t.pool.query(
      `insert into settings (id, key, market, scope, scope_id, value)
       values ($1, 'fx_change_pending', 'BD', 'market', null, $2::jsonb)
       on conflict (key, market, scope, scope_id) do update set value = excluded.value`,
      [uuidv7(), value],
    );
    return r.fxChanges.approve({ market: "BD", at: AT }, "checked");
  },
  "fxRates.set": (r) =>
    r.fxRates.set(
      {
        market: "BD",
        rate: "127",
        effectiveFrom: new Date("2026-11-11T06:00:00.000Z"),
        at: new Date("2026-11-11T06:00:00.000Z"),
      },
      "first rate",
    ),
  "pricingRules.save": (r) =>
    r.pricingRules.save(
      {
        market: "BD",
        productFamily: null,
        effectiveFrom: new Date("2026-11-11T06:00:00.000Z"),
        at: new Date("2026-11-11T06:00:00.000Z"),
        steps: [
          {
            code: "markup",
            rate: "0",
            base: "aws",
            label: { bn: "সার্ভিস চার্জ", en: "Service charge" },
          },
        ],
      },
      "first rule",
    ),
  "priceBook.save": (r) =>
    r.priceBook.save(
      {
        market: "BD",
        family: "linux_instance",
        margin: { kind: "percent", value: "0.1" },
        commission: null,
        effectiveFrom: new Date("2026-11-11T06:00:00.000Z"),
        at: new Date("2026-11-11T06:00:00.000Z"),
      },
      "first margin",
    ),
  "priceBook.setBaseCost": async (r) =>
    r.priceBook.setBaseCost(
      {
        catalogProductId: (
          await t.pool.query("select id from catalog_products where family = 'disk' limit 1")
        ).rows[0].id,
        awsPriceUsd: "0.2",
      },
      "AWS price page",
    ),
  "blueprints.setEnabled": async (r) => {
    const id = "repos_case_" + uniqueSuffix().toLowerCase();
    await t.pool.query(
      "insert into catalog_products (id, family, aws_id, platform, region, specs, aws_price_usd, billing_unit, feature_flag, active, synced_at) values ($1, 'blueprint', $2, 'linux', 'ap-southeast-1', '{}', 0, 'none', 'linux_instance', true, now())",
      [uuidv7(), id],
    );
    return r.blueprints.setEnabled({ market: "BD", blueprintId: id, enabled: true }, "allow-list");
  },
  "blueprints.setMinPower": async (r) => {
    const id = "repos_min_" + uniqueSuffix().toLowerCase();
    await t.pool.query(
      "insert into catalog_products (id, family, aws_id, platform, region, specs, aws_price_usd, billing_unit, feature_flag, active, synced_at) values ($1, 'blueprint', $2, 'linux', 'ap-southeast-1', '{}', 0, 'none', 'linux_instance', true, now())",
      [uuidv7(), id],
    );
    return r.blueprints.setMinPower(
      { market: "BD", blueprintId: id, minPower: 1000 },
      "needs 1 GB",
    );
  },
  "configPrices.save": (r) =>
    r.configPrices.save(
      {
        market: "BD",
        key: "config_price.snapshot_gb_month",
        usd: "0.05",
        effectiveFrom: new Date("2026-11-11T06:00:00.000Z"),
        at: new Date("2026-11-11T06:00:00.000Z"),
      },
      "AWS price page",
    ),
  "invoiceSeller.save": (r) =>
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
      "enter the seller",
    ),
  "tierLimits.save": (r) =>
    r.tierLimits.save(
      {
        market: "BD",
        tier: "trusted",
        limits: {
          maxInstances: 300,
          maxBundleUsd: "9999",
          windows: true,
          containers: false,
          maxStaticIps: 1,
        },
      },
      "raise",
    ),
  "capacity.addPoolAccount": (r) =>
    r.capacity.addPoolAccount(
      {
        awsAccountId: "123456789012",
        name: "tc-pool-case",
        tier: "new",
        roleArn: "arn:aws:iam::123456789012:role/TcProvisioner",
        externalId: "ext-case",
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
    r.capacity.setReserve(
      { market: "BD", quotaCode: "instance_vcpu", reserve: 1 },
      "keep one vCPU",
    ),
  "operations.clearPlanChangeMark": async (r) => {
    const resourceId = await newResource(t.pool, await newCustomer(t.pool), {
      family: "cdn",
      state: "active",
      config: JSON.stringify({ pendingPlanFailed: { code: "conflict" } }),
    });
    return r.operations.clearPlanChangeMark({ resourceId, requestId: uuidv7(), at: AT }, "clear");
  },
  "operations.approve": async (r) =>
    r.operations.approve({ operationId: await seedOperation("needs_approval"), at: AT }, "checked"),
  "operations.retry": async (r) =>
    r.operations.retry({ operationId: await seedOperation("needs_attention"), at: AT }, "retry"),
  "operations.reject": async (r) =>
    r.operations.reject({ operationId: await seedOperation("needs_approval"), at: AT }, "no"),
  "waitlist.notifyNext": (r) =>
    r.waitlist.notifyNext(
      { productFamily: "linux_instance", region: "ap-southeast-1", reason: "capacity", count: 1 },
      "one unit freed",
    ),
  "wallets.createAdjustment": async (r) =>
    r.wallets.createAdjustment(
      {
        requestId: uuidv7(),
        at: AT,
        customerId: (await fundedWallet(t.pool, 0n)).customerId,
        direction: "credit",
        amountMinor: 100n,
        kind: "deposit",
      },
      "bank deposit",
      testPoster,
    ),
  "wallets.approveAdjustment": async (r) =>
    r.wallets.approveAdjustment({ id: await seedAdjustment() }, "slip checked", testPoster),
  "wallets.rejectAdjustment": async (r) =>
    r.wallets.rejectAdjustment({ id: await seedAdjustment() }, "no slip"),
  "wallets.creditWalletForFailedChange": async (r) =>
    r.wallets.creditWalletForFailedChange(
      { operationId: await seedFailedApply(), at: new Date() },
      "apply rejected, capacity not delivered",
      okReverser,
    ),
  "payments.reverify": async (r) =>
    r.payments.reverify({ paymentId: await seedReviewPayment() }, "customer sent a receipt"),
  "payments.recordManualRefund": async (r) => {
    const w = await fundedWallet(t.pool, 5_000n);
    const p = await newPayment(t.pool, w.customerId, {
      amount_minor: 5_000n,
      status: "credited",
      ledger_transaction_id: w.topupId,
    });
    return r.payments.recordManualRefund(
      { paymentId: p.id, amountMinor: 100n },
      "refunded in the EPS dashboard",
      testPoster,
    );
  },
  "payments.resolveDiscrepancy": async (r) =>
    r.payments.resolveDiscrepancy(
      { id: await insertRow(t.pool, "discrepancies", { kind: "payment", details: {} }) },
      "settled",
    ),
};
// Admin reads ("<repo>.<method>") that write no audit row. Empty until WP8 decides where admin reads live and whether a read is audited (open point 21).
const ADMIN_READ_METHODS: readonly string[] = [
  "adminUsers.detail",
  "adminUsers.list",
  "audit.detail",
  "audit.export",
  "audit.search",
  "blueprints.list",
  "abuse.detail",
  "abuse.list",
  "reconciliation.list",
  "reconciliation.overview",
  "support.detail",
  "support.list",
  "capacity.list",
  "capacity.overview",
  "capacity.pending",
  "customers.detail",
  "customers.kycQueue",
  "customers.search",
  "operations.counts",
  "operations.detail",
  "operations.planChange",
  "operations.queue",
  "payments.detail",
  "payments.discrepancies",
  "payments.search",
  "fxChanges.read",
  "priceBook.read",
  "configPrices.read",
  "tierLimits.read",
  "invoiceSeller.read",
  "invoiceSeller.backlog",
  "waitlist.counts",
  "waitlist.list",
  "wallets.detail",
];

it("every method of adminRepos is a listed read or a write with an audit case", () => {
  const repos = adminRepos({} as Tx, { adminId: uuidv7(), role: "ops", ip: "203.0.113.9" });
  const methods = Object.entries(repos)
    .flatMap(([n, r]) => Object.keys(r).map((m) => `${n}.${m}`))
    .sort();
  expect([...Object.keys(ADMIN_WRITE_CASES), ...ADMIN_READ_METHODS].sort()).toEqual(methods);
});

it.each(Object.entries(ADMIN_WRITE_CASES))(
  "%s writes one audit row with actor, reason, IP and target (R10)",
  async (name, run) => {
    await ensureMarket(t.pool);
    const a = await actor(roleOf(name));
    await asAdmin(a, run);
    const rows = await auditRows(a.adminId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ actor_type: "admin", ip: "203.0.113.9", user_agent: "test" });
    expect(row?.target_type).toBeTruthy();
    expect(row?.target_id).toBeTruthy();
    expect(row?.metadata.reason).toBeTruthy();
  },
);

it("featureFlags.set stores the flag and the change; the same value again is a replay with its own audit row", async () => {
  await ensureMarket(t.pool);
  const a = await actor();
  expect(
    await asAdmin(a, (r) =>
      r.featureFlags.set({ key: "bucket", market: "BD", enabled: true }, "beta"),
    ),
  ).toEqual({ ok: true, replayed: false, value: { key: "bucket", market: "BD", enabled: true } });
  expect(
    await asAdmin(a, (r) =>
      r.featureFlags.set({ key: "bucket", market: "BD", enabled: true }, "beta again"),
    ),
  ).toMatchObject({ ok: true, replayed: true });
  expect(await flag("bucket")).toEqual([{ enabled: true }]);
  expect((await auditRows(a.adminId)).map((r) => [r.action, r.target_id, r.metadata])).toEqual([
    ["feature_flag.set", "BD:bucket", { reason: "beta", before: null, after: { enabled: true } }],
    [
      "feature_flag.set",
      "BD:bucket",
      { reason: "beta again", before: { enabled: true }, after: { enabled: true } },
    ],
  ]);
});

it("a blank reason is a validation failure and nothing is written", async () => {
  await ensureMarket(t.pool);
  const a = await actor();
  expect(
    await asAdmin(a, (r) => r.featureFlags.set({ key: "cdn", market: "BD", enabled: true }, "   ")),
  ).toEqual({ ok: false, error: "validation" });
  expect(await flag("cdn")).toEqual([]);
  expect(await auditRows(a.adminId)).toEqual([]);
});

it("the write and its audit row commit or roll back together", async () => {
  await ensureMarket(t.pool);
  const a = { ...(await actor()), ip: "not-an-ip" };
  await expect(
    asAdmin(a, (r) => r.featureFlags.set({ key: "dns", market: "BD", enabled: true }, "x")),
  ).rejects.toMatchObject({ name: "DbError", code: "22P02" });
  expect(await flag("dns")).toEqual([]);
});

it("adminRepos refuses an incomplete actor before any query", () => {
  for (const bad of [
    { adminId: "x", role: "ops", ip: "203.0.113.9" },
    { adminId: uuidv7(), role: "ops", ip: "" },
  ] as AdminActor[]) {
    expect(() => adminRepos({} as Tx, bad)).toThrow(
      new TypeError("adminRepos: the admin actor is incomplete"),
    );
  }
});
