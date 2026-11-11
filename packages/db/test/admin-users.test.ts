import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// 16.12 /admins: list the admin users, create the record, set the role, disable and enable. Superadmin
// only. The last active superadmin cannot be disabled or demoted, nobody changes their own role, and
// the admin who acts is always the one of the verified session (R10). Every write has its audit row.
const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "superadmin"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const row = async (id: string) =>
  (await t.pool.query("select role, status, cognito_sub from admin_users where id = $1", [id]))
    .rows[0];
const activeSuperadmins = async () =>
  Number(
    (
      await t.pool.query(
        "select count(*) as n from admin_users where role = 'superadmin' and status = 'active'",
      )
    ).rows[0].n,
  );
// The test database is shared by the tests of this file: make this admin the only active superadmin.
async function onlySuperadmin(): Promise<AdminActor> {
  await t.pool.query(
    "update admin_users set status = 'disabled' where role = 'superadmin' and status = 'active'",
  );
  return actorOf("superadmin");
}

it("create writes the record and one audit row with actor, reason, IP and target; the same request replays", async () => {
  const a = await actorOf();
  const sub = "sub-" + uniqueSuffix();
  const made = await asAdmin(a, (r) =>
    r.adminUsers.create({ cognitoSub: sub, role: "finance" }, "new accountant"),
  );
  expect(made.ok && made.value).toMatchObject({ role: "finance", status: "active" });
  expect(made.ok && made.replayed).toBe(false);
  const id = made.ok ? made.value.id : "";
  expect(await row(id)).toMatchObject({ role: "finance", status: "active", cognito_sub: sub });
  const again = await asAdmin(a, (r) =>
    r.adminUsers.create({ cognitoSub: sub, role: "finance" }, "new accountant"),
  );
  expect(again).toMatchObject({ ok: true, replayed: true, value: { id } });
  expect(
    await asAdmin(a, (r) => r.adminUsers.create({ cognitoSub: sub, role: "ops" }, "other role")),
  ).toEqual({ ok: false, error: "conflict" });
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit.map((x) => [x.action, x.target_type, x.target_id])).toEqual([
    ["admin_user.create", "admin_user", id],
    ["admin_user.create", "admin_user", id],
  ]);
  expect(audit[0]).toMatchObject({ actor_type: "admin", ip: "203.0.113.9", user_agent: "test" });
  expect(audit[0]?.metadata).toMatchObject({
    reason: "new accountant",
    before: null,
    after: { role: "finance", status: "active" },
  });
  // the Cognito sub is not copied into the audit row
  expect(JSON.stringify(audit)).not.toContain(sub);
});

it("create refuses a bad role, a bad sub and a blank reason, and writes nothing", async () => {
  const a = await actorOf();
  for (const input of [
    { cognitoSub: "sub-x", role: "root" },
    { cognitoSub: "", role: "ops" },
    { cognitoSub: "x".repeat(129), role: "ops" },
    { cognitoSub: "has space", role: "ops" },
  ] as never[]) {
    expect(await asAdmin(a, (r) => r.adminUsers.create(input, "reason"))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(
    await asAdmin(a, (r) =>
      r.adminUsers.create({ cognitoSub: "sub-" + uniqueSuffix(), role: "ops" }, "  "),
    ),
  ).toEqual({ ok: false, error: "validation" });
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});

it("setRole changes the role, replays the same role, and never touches the own role", async () => {
  const a = await actorOf();
  const other = await newAdmin(t.pool, "support");
  const done = await asAdmin(a, (r) =>
    r.adminUsers.setRole({ adminId: other, role: "ops" }, "moved to ops"),
  );
  expect(done).toMatchObject({ ok: true, replayed: false, value: { id: other, role: "ops" } });
  expect((await row(other)).role).toBe("ops");
  expect(
    await asAdmin(a, (r) => r.adminUsers.setRole({ adminId: other, role: "ops" }, "again")),
  ).toMatchObject({ ok: true, replayed: true });
  // a superadmin cannot change their own role, even to the same one
  for (const role of ["ops", "superadmin"] as const) {
    expect(
      await asAdmin(a, (r) => r.adminUsers.setRole({ adminId: a.adminId, role }, "self")),
    ).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
  expect((await row(a.adminId)).role).toBe("superadmin");
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit.map((x) => x.action)).toEqual(["admin_user.set_role", "admin_user.set_role"]);
  expect(audit[0]?.metadata).toMatchObject({
    reason: "moved to ops",
    before: { role: "support" },
    after: { role: "ops" },
  });
  expect(
    await asAdmin(a, (r) => r.adminUsers.setRole({ adminId: uuidv7(), role: "ops" }, "who")),
  ).toEqual({ ok: false, error: "not_found" });
  expect(
    await asAdmin(a, (r) => r.adminUsers.setRole({ adminId: other, role: "boss" as never }, "bad")),
  ).toEqual({ ok: false, error: "validation" });
});

it("the last active superadmin stays: a lone superadmin cannot demote or disable itself, and another superadmin may remove a peer", async () => {
  const sole = await onlySuperadmin();
  expect(await activeSuperadmins()).toBe(1);
  expect(
    await asAdmin(sole, (r) => r.adminUsers.setRole({ adminId: sole.adminId, role: "ops" }, "step down")),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(await asAdmin(sole, (r) => r.adminUsers.disable({ adminId: sole.adminId }, "leave"))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await activeSuperadmins()).toBe(1);
  // with a peer, the actor may demote or disable the peer and stays active
  const peer = await actorOf("superadmin");
  expect(
    await asAdmin(sole, (r) => r.adminUsers.setRole({ adminId: peer.adminId, role: "ops" }, "peer to ops")),
  ).toMatchObject({ ok: true });
  expect(await activeSuperadmins()).toBe(1);
  expect(await row(sole.adminId)).toMatchObject({ role: "superadmin", status: "active" });
});

it("disable and enable are idempotent, never for oneself, and a disabled admin can no longer act", async () => {
  const a = await actorOf();
  const other = await actorOf("finance");
  expect(await asAdmin(a, (r) => r.adminUsers.disable({ adminId: a.adminId }, "self"))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(
    await asAdmin(a, (r) => r.adminUsers.disable({ adminId: other.adminId }, "left the team")),
  ).toMatchObject({
    ok: true,
    replayed: false,
    value: { status: "disabled" },
  });
  expect(
    await asAdmin(a, (r) => r.adminUsers.disable({ adminId: other.adminId }, "again")),
  ).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect((await row(other.adminId)).status).toBe("disabled");
  // the disabled admin's own request is refused at once (H1)
  expect(await asAdmin(other, (r) => r.audit.search({}))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(
    await asAdmin(a, (r) => r.adminUsers.enable({ adminId: other.adminId }, "back")),
  ).toMatchObject({
    ok: true,
    replayed: false,
    value: { status: "active" },
  });
  expect(
    await asAdmin(a, (r) => r.adminUsers.enable({ adminId: other.adminId }, "back again")),
  ).toMatchObject({
    ok: true,
    replayed: true,
  });
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit.map((x) => x.action)).toEqual([
    "admin_user.disable",
    "admin_user.disable",
    "admin_user.enable",
    "admin_user.enable",
  ]);
  expect(audit[0]?.metadata).toMatchObject({
    before: { status: "active" },
    after: { status: "disabled" },
  });
});

it("two superadmins that disable each other at the same moment leave one active", async () => {
  const a = await onlySuperadmin();
  const b = await actorOf("superadmin");
  const out = await Promise.allSettled([
    asAdmin(a, (r) => r.adminUsers.disable({ adminId: b.adminId }, "race a")),
    asAdmin(b, (r) => r.adminUsers.disable({ adminId: a.adminId }, "race b")),
  ]);
  expect(await activeSuperadmins()).toBe(1);
  const wins = out.filter((o) => o.status === "fulfilled" && o.value.ok).length;
  expect(wins).toBe(1);
});

it("only a superadmin reads or writes; every other role, a disabled admin and an unknown admin are refused", async () => {
  const target = await newAdmin(t.pool, "support");
  const gone = await actorOf("superadmin");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [gone.adminId]);
  const unknown: AdminActor = { adminId: uuidv7(), role: "superadmin", ip: "203.0.113.9" };
  const actors = [
    await actorOf("support"),
    await actorOf("finance"),
    await actorOf("ops"),
    gone,
    unknown,
  ];
  for (const who of actors) {
    const label = `${who.role}`;
    const calls = [
      asAdmin(who, (r) => r.adminUsers.list()),
      asAdmin(who, (r) => r.adminUsers.detail(target)),
      asAdmin(who, (r) =>
        r.adminUsers.create({ cognitoSub: "s-" + uniqueSuffix(), role: "ops" }, "x"),
      ),
      asAdmin(who, (r) => r.adminUsers.setRole({ adminId: target, role: "ops" }, "x")),
      asAdmin(who, (r) => r.adminUsers.disable({ adminId: target }, "x")),
      asAdmin(who, (r) => r.adminUsers.enable({ adminId: target }, "x")),
      asAdmin(who, (r) =>
        r.adminUsers.recordDirectoryAction({ adminId: target, kind: "mfa_reset" }, "x"),
      ),
    ];
    for (const out of await Promise.all(calls))
      expect(out, label).toEqual({ ok: false, error: "forbidden" });
  }
  expect((await row(target)).role).toBe("support");
});

it("list pages and filters; detail shows the record; recordDirectoryAction writes one audit row and no change", async () => {
  const a = await actorOf();
  const made: string[] = [];
  for (let i = 0; i < 3; i += 1) made.push(await newAdmin(t.pool, "ops"));
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [made[0]]);
  const disabled = await asAdmin(a, (r) => r.adminUsers.list({ status: "disabled" }));
  expect(disabled.ok && disabled.value.rows.map((x) => x.id)).toContain(made[0]);
  expect(disabled.ok && disabled.value.rows.every((x) => x.status === "disabled")).toBe(true);
  const first = await asAdmin(a, (r) => r.adminUsers.list({ role: "ops", limit: 2 }));
  expect(first.ok && first.value.rows).toHaveLength(2);
  const next = await asAdmin(a, (r) =>
    r.adminUsers.list({ role: "ops", limit: 2, after: first.ok ? first.value.nextAfter! : "" }),
  );
  expect(next.ok && next.value.rows.length).toBeGreaterThan(0);
  for (const bad of [{ role: "boss" }, { status: "x" }, { limit: 0 }, { after: "x" }] as never[]) {
    expect(await asAdmin(a, (r) => r.adminUsers.list(bad))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(await asAdmin(a, (r) => r.adminUsers.detail(made[1]!))).toMatchObject({
    ok: true,
    value: { id: made[1], role: "ops", status: "active" },
  });
  expect(await asAdmin(a, (r) => r.adminUsers.detail(uuidv7()))).toEqual({
    ok: false,
    error: "not_found",
  });
  const before = await row(made[1]!);
  const rec = await asAdmin(a, (r) =>
    r.adminUsers.recordDirectoryAction({ adminId: made[1]!, kind: "mfa_reset" }, "lost phone"),
  );
  expect(rec).toMatchObject({ ok: true, value: { id: made[1] } });
  expect(await row(made[1]!)).toEqual(before);
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit.at(-1)).toMatchObject({
    action: "admin_user.mfa_reset",
    target_type: "admin_user",
    target_id: made[1],
  });
  expect(audit.at(-1)?.metadata).toMatchObject({ reason: "lost phone" });
  expect(
    await asAdmin(a, (r) =>
      r.adminUsers.recordDirectoryAction({ adminId: uuidv7(), kind: "mfa_reset" }, "x"),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(
    await asAdmin(a, (r) =>
      r.adminUsers.recordDirectoryAction({ adminId: made[1]!, kind: "other" as never }, "x"),
    ),
  ).toEqual({ ok: false, error: "validation" });
});
