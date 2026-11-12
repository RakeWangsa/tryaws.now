import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { maskEmail, maskPhone } from "../repositories/admin/customers";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// 16.12 /customers: reads, KYC decisions, risk tier, suspend and resume as admin_rw (migration 0006),
// every write with its audit row (R10), a role outside the list refused (R16).
const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const AT = new Date("2026-11-12T08:00:00.000Z");

async function submission(customerId: string, over: Record<string, unknown> = {}) {
  return insertRow(t.pool, "kyc_submissions", {
    customer_id: customerId,
    document_type: "nid",
    document_number_encrypted: Buffer.from([1, 2, 3]),
    s3_keys: ["kyc/c/front.jpg", "kyc/c/back.jpg"],
    ...over,
  });
}
const row = async (sql: string, args: unknown[]) => (await t.pool.query(sql, args)).rows[0];

it("masks an email and a phone number", () => {
  expect(maskEmail("abcd@example.com")).toBe("a***@example.com");
  expect(maskEmail("nonsense")).toBe("***");
  expect(maskPhone("+8801712345678")).toBe("+8801*******78");
  expect(maskPhone("123")).toBe("***");
});

it("search finds by id, exact email, exact phone and name prefix, and shows masked fields only", async () => {
  const a = await actorOf("support");
  const phone = "+88017" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const name = "Zed" + uniqueSuffix();
  const id = await newCustomer(t.pool, {
    name,
    phone,
    email: "Person" + uniqueSuffix() + "@Example.test",
  });
  const email = (await row("select email from customers where id = $1", [id])).email as string;
  for (const q of [id, email.toLowerCase(), phone, phone.replace("+88", ""), name.slice(0, 5)]) {
    const out = await asAdmin(a, (r) => r.customers.search({ q }));
    expect(out.ok && out.value.rows.map((r) => r.id), q).toContain(id);
  }
  const out = await asAdmin(a, (r) => r.customers.search({ q: id }));
  const found = out.ok ? out.value.rows[0] : undefined;
  expect(JSON.stringify(found)).not.toContain(email);
  expect(JSON.stringify(found)).not.toContain(phone);
  expect(found?.emailMasked).toBe(maskEmail(email));
  expect(found?.phoneMasked).toBe(maskPhone(phone));
});

it("search pages by id and filters by KYC status; wildcard characters of a name are literal", async () => {
  const a = await actorOf("ops");
  await newCustomer(t.pool, { kyc_status: "pending", name: "Pager%One" });
  await newCustomer(t.pool, { kyc_status: "pending", name: "Pager%Two" });
  const first = await asAdmin(a, (r) => r.customers.search({ q: "Pager%", limit: 1 }));
  expect(first.ok && first.value.rows).toHaveLength(1);
  expect(first.ok && first.value.nextAfter).not.toBeNull();
  const next = await asAdmin(a, (r) =>
    r.customers.search({ q: "Pager%", limit: 1, after: first.ok ? first.value.nextAfter! : "" }),
  );
  expect(next.ok && next.value.rows).toHaveLength(1);
  expect(next.ok && next.value.rows[0]?.id).not.toBe(first.ok && first.value.rows[0]?.id);
  const none = await asAdmin(a, (r) => r.customers.search({ q: "%", kycStatus: "pending" }));
  expect(none.ok && none.value.rows).toEqual([]);
  expect(await asAdmin(a, (r) => r.customers.search({ limit: 0 }))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.customers.search({ q: "x".repeat(101) }))).toEqual({
    ok: false,
    error: "validation",
  });
});

it("detail shows the profile, wallet, resources, submissions and the audit trail; no raw email or key", async () => {
  const a = await actorOf("ops");
  const id = await newCustomer(t.pool, { name: "Detail Person", phone: "+8801712345678" });
  const sub = await submission(id);
  await insertRow(t.pool, "wallets", { customer_id: id, currency: "BDT", balance_minor: 12345 });
  await asAdmin(a, (r) => r.customers.setRiskTier({ customerId: id, tier: "trusted" }, "known"));
  const out = await asAdmin(a, (r) => r.customers.detail(id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value.wallet).toEqual({ currency: "BDT", balanceMinor: 12345n });
  expect(out.value.resourceCount).toBe(0);
  expect(out.value.kycSubmissions).toMatchObject([
    { id: sub, documentCount: 2, status: "pending" },
  ]);
  expect(out.value.audit.map((x) => [x.action, x.reason])).toEqual([
    ["customer.set_risk_tier", "known"],
  ]);
  const text = JSON.stringify(out.value, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  expect(text).not.toContain("front.jpg");
  expect(text).not.toContain("+8801712345678");
});

it("detail of an unknown or malformed id is not_found", async () => {
  const a = await actorOf("support");
  expect(await asAdmin(a, (r) => r.customers.detail(uuidv7()))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await asAdmin(a, (r) => r.customers.detail("nope"))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("kycQueue lists pending submissions oldest first", async () => {
  const a = await actorOf("support");
  const c1 = await newCustomer(t.pool, { kyc_status: "pending" });
  const s1 = await submission(c1);
  const c2 = await newCustomer(t.pool, { kyc_status: "pending" });
  const s2 = await submission(c2);
  const out = await asAdmin(a, (r) => r.customers.kycQueue({ limit: 100 }));
  const ids = out.ok ? out.value.map((x) => x.submissionId) : [];
  expect(ids.indexOf(s1)).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(s1)).toBeLessThan(ids.indexOf(s2));
});

it("approveKyc verifies the customer, stores reviewer, time and note, and audits against the customer", async () => {
  const a = await actorOf("ops");
  const c = await newCustomer(t.pool, { kyc_status: "pending" });
  const s = await submission(c);
  const out = await asAdmin(a, (r) =>
    r.customers.approveKyc({ submissionId: s, at: AT, note: "ok" }, "documents match"),
  );
  expect(out).toEqual({
    ok: true,
    replayed: false,
    value: { submissionId: s, customerId: c, status: "verified" },
  });
  expect(await row("select kyc_status from customers where id = $1", [c])).toEqual({
    kyc_status: "verified",
  });
  expect(
    await row("select status, reviewer_id, reviewed_at, note from kyc_submissions where id = $1", [
      s,
    ]),
  ).toEqual({ status: "verified", reviewer_id: a.adminId, reviewed_at: AT, note: "ok" });
  const [audit] = await auditRowsOf(t.pool, a.adminId);
  expect(audit).toMatchObject({
    actor_type: "admin",
    action: "kyc.approve",
    target_type: "customer",
    target_id: c,
    ip: "203.0.113.9",
  });
  expect(audit?.metadata.reason).toBe("documents match");
});

it("approveKyc again is a replay and changes nothing; the opposite decision is a conflict", async () => {
  const a = await actorOf("ops");
  const c = await newCustomer(t.pool, { kyc_status: "pending" });
  const s = await submission(c);
  await asAdmin(a, (r) => r.customers.approveKyc({ submissionId: s, at: AT }, "first"));
  expect(
    await asAdmin(a, (r) =>
      r.customers.approveKyc({ submissionId: s, at: new Date("2027-01-01") }, "second"),
    ),
  ).toMatchObject({ ok: true, replayed: true });
  expect(
    (await row("select reviewed_at from kyc_submissions where id = $1", [s])).reviewed_at,
  ).toEqual(AT);
  expect(
    await asAdmin(a, (r) => r.customers.rejectKyc({ submissionId: s, at: AT }, "late")),
  ).toEqual({
    ok: false,
    error: "conflict",
  });
  expect((await row("select kyc_status from customers where id = $1", [c])).kyc_status).toBe(
    "verified",
  );
});

it("rejectKyc rejects with the note; only the newest submission of a customer can be decided", async () => {
  const a = await actorOf("superadmin");
  const c = await newCustomer(t.pool, { kyc_status: "pending" });
  // WPU-D3: one pending submission per customer (index), so the older one was decided earlier.
  const older = await submission(c);
  await t.pool.query(
    "update kyc_submissions set status = 'rejected', reviewer_id = $2, reviewed_at = now() where id = $1",
    [older, a.adminId],
  );
  const newer = await submission(c);
  expect(
    await asAdmin(a, (r) => r.customers.rejectKyc({ submissionId: older, at: AT }, "old")),
  ).toEqual({
    ok: false,
    error: "conflict",
  });
  const out = await asAdmin(a, (r) =>
    r.customers.rejectKyc({ submissionId: newer, at: AT, note: "blurred image" }, "unreadable"),
  );
  expect(out).toMatchObject({ ok: true, value: { status: "rejected" } });
  expect(await row("select kyc_status from customers where id = $1", [c])).toEqual({
    kyc_status: "rejected",
  });
  expect((await row("select note from kyc_submissions where id = $1", [newer])).note).toBe(
    "blurred image",
  );
  expect((await row("select status from kyc_submissions where id = $1", [older])).status).toBe(
    "rejected",
  );
});

it("KYC decisions refuse bad input and unknown rows without writing an audit row", async () => {
  const a = await actorOf("ops");
  const bad = [
    { submissionId: "x", at: AT },
    { submissionId: uuidv7(), at: new Date("nope") },
    { submissionId: uuidv7(), at: AT, note: "n".repeat(501) },
  ];
  for (const input of bad) {
    expect(await asAdmin(a, (r) => r.customers.approveKyc(input, "r"))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(
    await asAdmin(a, (r) => r.customers.approveKyc({ submissionId: uuidv7(), at: AT }, "r")),
  ).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});

it("support reads but cannot act: every write is forbidden and writes nothing", async () => {
  const a = await actorOf("support");
  const c = await newCustomer(t.pool, { kyc_status: "pending" });
  const s = await submission(c);
  const forbidden = { ok: false, error: "forbidden" };
  expect(await asAdmin(a, (r) => r.customers.approveKyc({ submissionId: s, at: AT }, "r"))).toEqual(
    forbidden,
  );
  expect(await asAdmin(a, (r) => r.customers.rejectKyc({ submissionId: s, at: AT }, "r"))).toEqual(
    forbidden,
  );
  expect(
    await asAdmin(a, (r) => r.customers.setRiskTier({ customerId: c, tier: "trusted" }, "r")),
  ).toEqual(forbidden);
  expect(await asAdmin(a, (r) => r.customers.suspend({ customerId: c, at: AT }, "r"))).toEqual(
    forbidden,
  );
  expect(await asAdmin(a, (r) => r.customers.resume({ customerId: c, at: AT }, "r"))).toEqual(
    forbidden,
  );
  expect(
    await row("select kyc_status, risk_tier, status from customers where id = $1", [c]),
  ).toEqual({
    kyc_status: "pending",
    risk_tier: "new",
    status: "active",
  });
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
  expect((await asAdmin(a, (r) => r.customers.detail(c))).ok).toBe(true);
});

it("finance reads nothing and acts on nothing", async () => {
  const a = await actorOf("finance");
  const c = await newCustomer(t.pool);
  const forbidden = { ok: false, error: "forbidden" };
  expect(await asAdmin(a, (r) => r.customers.search({}))).toEqual(forbidden);
  expect(await asAdmin(a, (r) => r.customers.detail(c))).toEqual(forbidden);
  expect(await asAdmin(a, (r) => r.customers.kycQueue())).toEqual(forbidden);
  expect(
    await asAdmin(a, (r) => r.customers.documentRead({ submissionId: uuidv7(), index: 0 })),
  ).toEqual(forbidden);
});

it("setRiskTier changes the tier, replays the same tier and refuses an unknown one", async () => {
  const a = await actorOf("ops");
  const c = await newCustomer(t.pool);
  expect(
    await asAdmin(a, (r) => r.customers.setRiskTier({ customerId: c, tier: "trusted" }, "14 days")),
  ).toMatchObject({
    ok: true,
    replayed: false,
    value: { riskTier: "trusted" },
  });
  expect(
    await asAdmin(a, (r) => r.customers.setRiskTier({ customerId: c, tier: "trusted" }, "again")),
  ).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(
    await asAdmin(a, (r) => r.customers.setRiskTier({ customerId: c, tier: "vip" as "new" }, "r")),
  ).toEqual({
    ok: false,
    error: "validation",
  });
  expect(
    await asAdmin(a, (r) => r.customers.setRiskTier({ customerId: uuidv7(), tier: "new" }, "r")),
  ).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("suspend cuts the sessions, resume reopens; each repeat is a replay; the trail shows both", async () => {
  const a = await actorOf("ops");
  const c = await newCustomer(t.pool);
  expect(
    await asAdmin(a, (r) => r.customers.suspend({ customerId: c, at: AT }, "abuse report")),
  ).toMatchObject({
    ok: true,
    replayed: false,
    value: { status: "suspended" },
  });
  expect(
    await row("select status, sessions_valid_after from customers where id = $1", [c]),
  ).toEqual({
    status: "suspended",
    sessions_valid_after: AT,
  });
  expect(
    await asAdmin(a, (r) => r.customers.suspend({ customerId: c, at: new Date() }, "again")),
  ).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(
    (await row("select sessions_valid_after from customers where id = $1", [c]))
      .sessions_valid_after,
  ).toEqual(AT);
  expect(
    await asAdmin(a, (r) => r.customers.resume({ customerId: c, at: AT }, "cleared")),
  ).toMatchObject({
    ok: true,
    value: { status: "active" },
  });
  const detail = await asAdmin(a, (r) => r.customers.detail(c));
  expect(detail.ok && detail.value.audit.map((x) => x.action)).toEqual([
    "customer.resume",
    "customer.suspend",
    "customer.suspend",
  ]);
});

it("documentRead returns the key for the presigner and leaves an audit row; a bad index is not_found", async () => {
  const a = await actorOf("support");
  const c = await newCustomer(t.pool);
  const s = await submission(c);
  expect(await asAdmin(a, (r) => r.customers.documentRead({ submissionId: s, index: 1 }))).toEqual({
    ok: true,
    replayed: false,
    value: { customerId: c, key: "kyc/c/back.jpg" },
  });
  expect(await asAdmin(a, (r) => r.customers.documentRead({ submissionId: s, index: 2 }))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await asAdmin(a, (r) => r.customers.documentRead({ submissionId: s, index: -1 }))).toEqual(
    {
      ok: false,
      error: "validation",
    },
  );
  const rows = await auditRowsOf(t.pool, a.adminId);
  expect(rows.map((x) => [x.action, x.target_id])).toEqual([["kyc.document_view", c]]);
  expect(JSON.stringify(rows[0]?.metadata)).not.toContain("back.jpg");
});

it("a disabled admin cannot read the queue either", async () => {
  const a = await actorOf("ops");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [a.adminId]);
  expect(await asAdmin(a, (r) => r.customers.kycQueue())).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await asAdmin(a, (r) => r.customers.search({}))).toEqual({
    ok: false,
    error: "forbidden",
  });
});
