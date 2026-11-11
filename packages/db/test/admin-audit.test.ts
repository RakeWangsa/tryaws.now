import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { insertAudit } from "../repositories/audit-log";
import { runTransaction } from "../tx";
import { newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// 16.12 /audit: search the append-only audit log by actor, target, action and date, a page at a time,
// the details of one row, and the export of the filtered view with a hard row cap. Read only: the
// repository has no write method (R5/append-only), every read begins with the role and active-admin
// check (R16), and the metadata that leaves the repository is masked (R14).
const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "support"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});

interface Seed {
  actorId?: string | null;
  actorType?: "admin" | "customer" | "system";
  action?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  at?: string;
}

async function seed(over: Seed = {}): Promise<string> {
  const actorType = over.actorType ?? "admin";
  const actorId = actorType === "system" ? null : (over.actorId ?? uuidv7());
  const id = await runTransaction(
    t.db,
    (tx) =>
      insertAudit(tx, {
        actorType,
        actorId,
        action: over.action ?? "test.action",
        ...(over.targetType === undefined ? {} : { targetType: over.targetType }),
        ...(over.targetId === undefined ? {} : { targetId: over.targetId }),
        ip: "198.51.100.7",
        userAgent: "agent/1",
        metadata: over.metadata ?? { reason: "because" },
      }),
    { role: "admin_rw" },
  );
  if (over.at !== undefined) {
    await t.pool.query("alter table audit_log disable trigger user");
    await t.pool.query("update audit_log set created_at = $1 where id = $2", [over.at, id]);
    await t.pool.query("alter table audit_log enable trigger user");
  }
  return id;
}

it("search filters by actor, target, action and date, newest first", async () => {
  const a = await actorOf();
  const actor1 = uuidv7();
  const target = "T-" + uuidv7();
  const r1 = await seed({
    actorId: actor1,
    action: "payment.reverify",
    targetType: "payment",
    targetId: target,
    at: "2026-10-01T00:00:00Z",
  });
  const r2 = await seed({
    actorId: actor1,
    action: "payment.refund",
    targetType: "payment",
    targetId: target,
    at: "2026-10-05T00:00:00Z",
  });
  await seed({
    actorId: uuidv7(),
    action: "payment.refund",
    targetType: "payment",
    targetId: "other-" + uuidv7(),
  });
  const ids = async (input: Parameters<AdminRepos["audit"]["search"]>[0]) => {
    const out = await asAdmin(a, (r) => r.audit.search(input));
    return out.ok ? out.value.rows.map((x) => x.id) : out;
  };
  expect(await ids({ targetType: "payment", targetId: target })).toEqual([r2, r1]);
  expect(await ids({ actorId: actor1 })).toEqual([r2, r1]);
  expect(await ids({ actorId: actor1, action: "payment.refund" })).toEqual([r2]);
  // a prefix ends with a dot
  expect(await ids({ actorId: actor1, action: "payment." })).toEqual([r2, r1]);
  expect(
    await ids({
      actorId: actor1,
      from: new Date("2026-10-02T00:00:00Z"),
      to: new Date("2026-10-31T00:00:00Z"),
    }),
  ).toEqual([r2]);
  expect(await ids({ actorId: actor1, actorType: "customer" })).toEqual([]);
});

it("search pages by id with a cursor and refuses bad input", async () => {
  const a = await actorOf();
  const actor1 = uuidv7();
  for (let i = 0; i < 3; i += 1) await seed({ actorId: actor1 });
  const first = await asAdmin(a, (r) => r.audit.search({ actorId: actor1, limit: 2 }));
  expect(first.ok && first.value.rows).toHaveLength(2);
  const next = await asAdmin(a, (r) =>
    r.audit.search({ actorId: actor1, limit: 2, after: first.ok ? first.value.nextAfter! : "" }),
  );
  expect(next.ok && next.value.rows).toHaveLength(1);
  expect(next.ok && next.value.nextAfter).toBeNull();
  for (const bad of [
    { actorId: "not-a-uuid" },
    { after: "x" },
    { limit: 0 },
    { limit: 101 },
    { actorType: "robot" },
    { targetType: "Bad Type!" },
    { targetId: "x".repeat(101) },
    { action: "x".repeat(81) },
    { from: new Date("nope") },
    { from: new Date("2026-10-02T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") },
  ] as never[]) {
    expect(await asAdmin(a, (r) => r.audit.search(bad))).toEqual({
      ok: false,
      error: "validation",
    });
  }
});

it("a row shows actor, reason, IP, target and before/after, with secrets and personal data masked", async () => {
  const a = await actorOf();
  const id = await seed({
    action: "customer.update",
    targetType: "customer",
    targetId: "c1",
    metadata: {
      reason: "support asked",
      before: { email: "alice@example.com", phone: "+8801712345678", status: "active" },
      after: {
        password: "hunter2",
        token: "abc.def.ghi",
        secretKey: "s3cr3t",
        documentNumber: "1234567890",
        nid: "99",
        note: "write to bob@example.org or +8801812345678 please",
        nested: { otpCode: "123456", keep: "ok" },
        list: Array.from({ length: 30 }, (_v, i) => i),
        long: "x".repeat(500),
      },
    },
  });
  const out = await asAdmin(a, (r) => r.audit.detail(id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const row = out.value;
  expect(row).toMatchObject({
    id,
    actorType: "admin",
    action: "customer.update",
    targetType: "customer",
    targetId: "c1",
    ip: "198.51.100.7",
    userAgent: "agent/1",
    reason: "support asked",
  });
  const text = JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  for (const secret of [
    "alice@example.com",
    "bob@example.org",
    "+8801712345678",
    "+8801812345678",
    "hunter2",
    "abc.def.ghi",
    "s3cr3t",
    "1234567890",
    "123456",
  ]) {
    expect(text, secret).not.toContain(secret);
  }
  expect(row.before).toMatchObject({ status: "active", email: "a***@example.com" });
  expect(row.after).toMatchObject({ password: "[masked]", token: "[masked]", nid: "[masked]" });
  expect((row.after as { nested: { keep: string } }).nested.keep).toBe("ok");
  expect((row.after as { list: unknown[] }).list).toHaveLength(20);
  expect((row.after as { long: string }).long.length).toBeLessThanOrEqual(201);
  expect((row.after as { note: string }).note).toContain("b***@example.org");
});

it("detail of a missing or malformed id is not_found", async () => {
  const a = await actorOf();
  expect(await asAdmin(a, (r) => r.audit.detail(uuidv7()))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await asAdmin(a, (r) => r.audit.detail("nope"))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("every role reads; export is superadmin only and capped with a truncated flag", async () => {
  const actor1 = uuidv7();
  for (let i = 0; i < 4; i += 1) await seed({ actorId: actor1 });
  for (const role of ["support", "finance", "ops", "superadmin"] as const) {
    const a = await actorOf(role);
    const out = await asAdmin(a, (r) => r.audit.search({ actorId: actor1 }));
    expect(out.ok && out.value.rows).toHaveLength(4);
  }
  for (const role of ["support", "finance", "ops"] as const) {
    const a = await actorOf(role);
    expect(await asAdmin(a, (r) => r.audit.export({ actorId: actor1 }))).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
  const s = await actorOf("superadmin");
  const full = await asAdmin(s, (r) => r.audit.export({ actorId: actor1 }));
  expect(full.ok && full.value).toMatchObject({ truncated: false });
  expect(full.ok && full.value.rows).toHaveLength(4);
  const capped = await asAdmin(s, (r) => r.audit.export({ actorId: actor1 }, { cap: 3 }));
  expect(capped.ok && capped.value.rows).toHaveLength(3);
  expect(capped.ok && capped.value.truncated).toBe(true);
  expect(await asAdmin(s, (r) => r.audit.export({ actorId: actor1 }, { cap: 0 }))).toEqual({
    ok: false,
    error: "validation",
  });
});

it("a disabled admin, an unknown admin and a wrong role claim read nothing (fail closed)", async () => {
  const gone = await actorOf("support");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [gone.adminId]);
  const unknown: AdminActor = { adminId: uuidv7(), role: "support", ip: "203.0.113.9" };
  const wrongRole: AdminActor = { ...(await actorOf("support")), role: "superadmin" };
  for (const who of [gone, unknown, wrongRole]) {
    expect(await asAdmin(who, (r) => r.audit.search({}))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await asAdmin(who, (r) => r.audit.detail(uuidv7()))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await asAdmin(who, (r) => r.audit.export({}))).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
});

it("reading writes no audit row, and the repository has no write method", async () => {
  const a = await actorOf("superadmin");
  const before = Number((await t.pool.query("select count(*) as n from audit_log")).rows[0].n);
  await asAdmin(a, (r) => r.audit.search({}));
  await asAdmin(a, (r) => r.audit.export({}));
  const after = Number((await t.pool.query("select count(*) as n from audit_log")).rows[0].n);
  expect(after).toBe(before);
  const repos = adminRepos({} as never, { adminId: uuidv7(), role: "ops", ip: "203.0.113.9" });
  expect(Object.keys(repos.audit).sort()).toEqual(["detail", "export", "search"]);
});

it("masks by normalised key for every type, separator-tolerant phones and long digit runs in text, and keeps ids (R14)", async () => {
  const a = await actorOf("superadmin");
  const adminId = "0191a000-0000-7000-8000-0000000000ad";
  const id = await seed({
    targetType: "customer",
    targetId: "c9",
    metadata: {
      reason: "call +880 1712 345678 or 01712-345678",
      before: {
        phone: 8801712345678,
        mobileNumber: "01712345678",
        contacts: [{ whatsapp: 1712345678 }, { email: "carol@example.com" }],
        customerNid: "1990123456789",
        nidNumber: 123,
        NidNumber: "5",
        national_id: "x",
        passportNo: "A1",
        documentNumber: 42,
        cardNumber: "4111111111111111",
        actedBy: adminId,
        when: "2026-11-12 06:00:00",
        amountMinor: 1234567890123,
      },
      after: {
        note: "ref 12345678901234567890 and 4111 1111 1111 1111 done",
        deep: { a: { b: { c: { d: { phone: "01712345678" } } } } },
        weird: { email: 5 },
        list: [{ token: "t" }, "mail me dave@example.org"],
      },
    },
  });
  const out = await asAdmin(a, (r) => r.audit.detail(id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const text = JSON.stringify(out.value);
  for (const leak of [
    "8801712345678",
    "1712 345678",
    "01712-345678",
    "01712345678",
    "1712345678",
    "1990123456789",
    "4111",
    "12345678901234567890",
    "carol@example.com",
    "dave@example.org",
  ]) {
    expect(text, leak).not.toContain(leak);
  }
  const before = out.value.before as Record<string, unknown>;
  expect(before).toMatchObject({
    customerNid: "[masked]",
    nidNumber: "[masked]",
    NidNumber: "[masked]",
    national_id: "[masked]",
    passportNo: "[masked]",
    documentNumber: "[masked]",
    cardNumber: "[masked]",
    actedBy: adminId,
    when: "2026-11-12 06:00:00",
    amountMinor: 1234567890123,
  });
  expect(typeof before.phone).toBe("string");
  expect((before.phone as string).includes("*")).toBe(true);
  const after = out.value.after as { weird: { email: unknown }; list: unknown[] };
  expect(after.weird.email).toBe("[masked]");
  expect(after.list[0]).toEqual({ token: "[masked]" });
});

it("the export carries the same masked rows", async () => {
  const s = await actorOf("superadmin");
  const actor1 = uuidv7();
  await seed({ actorId: actor1, metadata: { reason: "x", after: { phone: 8801712345678 } } });
  const out = await asAdmin(s, (r) => r.audit.export({ actorId: actor1 }));
  expect(JSON.stringify(out)).not.toContain("8801712345678");
});
