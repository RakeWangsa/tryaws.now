import { beforeEach, expect, it } from "vitest";
import {
  bootstrapFirstSuperadmin,
  FIRST_ADMIN_ACTION,
  FIRST_ADMIN_ISOLATION_ERROR,
  FIRST_ADMIN_REASON,
} from "../repositories/system/first-admin";
import { useTempDatabase } from "./temp-db";

// WPU-Z18: the migrator, as the master user (the table owner, like the temp database's user here),
// writes the first superadmin only when admin_users has no row at all, with one system audit row, in
// one transaction serialised by the advisory lock of admin_users changes.
const t = useTempDatabase();
const SUB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "11111111-2222-4333-8444-555555555555";

const bootstrap = (sub: string) =>
  t.db.transaction((tx) => bootstrapFirstSuperadmin(tx, sub), { isolationLevel: "read committed" });
const admins = async () =>
  (await t.pool.query("select id, cognito_sub, role, status from admin_users order by id")).rows;
const bootstrapAudit = async () =>
  (
    await t.pool.query(
      "select actor_type, actor_id, action, target_type, target_id, ip, metadata from audit_log where action = $1 order by created_at",
      [FIRST_ADMIN_ACTION],
    )
  ).rows;

// admin_users must start empty in each case; nothing in a fresh database refers to these rows.
beforeEach(async () => {
  await t.pool.query("delete from admin_users");
});

it("inserts one active superadmin with the lowercase sub and one system audit row", async () => {
  const before = (await bootstrapAudit()).length;
  const out = await bootstrap(SUB.toUpperCase());
  if (out.outcome !== "inserted") throw new Error("expected inserted");
  const rows = await admins();
  expect(rows).toEqual([
    { id: out.adminId, cognito_sub: SUB, role: "superadmin", status: "active" },
  ]);
  const audit = await bootstrapAudit();
  expect(audit).toHaveLength(before + 1);
  expect(audit[audit.length - 1]).toEqual({
    actor_type: "system",
    actor_id: null,
    action: "admin_user.bootstrap",
    target_type: "admin_user",
    target_id: out.adminId,
    ip: null,
    metadata: {
      reason: "first superadmin bootstrap",
      before: null,
      after: { role: "superadmin", status: "active" },
    },
  });
  expect(FIRST_ADMIN_REASON).toBe("first superadmin bootstrap");
});

it("does nothing when any admin row exists, the same sub or another, active or disabled (R7)", async () => {
  await bootstrap(SUB);
  const audit = (await bootstrapAudit()).length;
  expect(await bootstrap(SUB)).toEqual({ outcome: "admins_exist" });
  expect(await bootstrap(OTHER)).toEqual({ outcome: "admins_exist" });
  await t.pool.query("update admin_users set status = 'disabled', role = 'support'");
  expect(await bootstrap(OTHER)).toEqual({ outcome: "admins_exist" });
  expect(await admins()).toHaveLength(1);
  expect((await admins())[0]).toMatchObject({ cognito_sub: SUB, role: "support" });
  expect(await bootstrapAudit()).toHaveLength(audit);
});

it("two concurrent runs on an empty table insert exactly one row", async () => {
  const audit = (await bootstrapAudit()).length;
  const outs = await Promise.all([bootstrap(SUB), bootstrap(OTHER), bootstrap(SUB)]);
  expect(outs.filter((o) => o.outcome === "inserted")).toHaveLength(1);
  expect(outs.filter((o) => o.outcome === "admins_exist")).toHaveLength(2);
  expect(await admins()).toHaveLength(1);
  expect(await bootstrapAudit()).toHaveLength(audit + 1);
});

it("refuses a sub that is not a canonical UUID before any statement (R16)", async () => {
  await expect(bootstrap("sub-123")).rejects.toThrow("first admin: the sub is not valid");
  expect(await admins()).toEqual([]);
});

it("refuses a REPEATABLE READ or SERIALIZABLE transaction and writes nothing (review M1)", async () => {
  for (const isolationLevel of ["repeatable read", "serializable"] as const) {
    await expect(
      t.db.transaction((tx) => bootstrapFirstSuperadmin(tx, SUB), { isolationLevel }),
    ).rejects.toThrow(FIRST_ADMIN_ISOLATION_ERROR);
  }
  expect(await admins()).toEqual([]);
});
