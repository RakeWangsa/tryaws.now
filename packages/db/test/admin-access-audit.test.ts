import { expect, it } from "vitest";
import { recordAdminAccess } from "../repositories/admin/access-audit";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const asAdminRole = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "admin_rw" });

it("a successful sign-in is an admin row with the IP and the agent", async () => {
  const id = await newAdmin(t.pool, "ops");
  await asAdminRole((tx) =>
    recordAdminAccess(tx, {
      adminId: id,
      action: "admin.sign_in",
      ip: "203.0.113.9",
      userAgent: "agent",
      outcome: "ok",
    }),
  );
  const [row] = await auditRowsOf(t.pool, id);
  expect(row).toMatchObject({
    actor_type: "admin",
    action: "admin.sign_in",
    target_type: "admin",
    target_id: id,
    ip: "203.0.113.9",
    user_agent: "agent",
  });
  expect(row?.metadata).toEqual({ outcome: "ok" });
});

it("a refused sign-in is a system row with no admin and no email, only the reason code", async () => {
  await asAdminRole((tx) =>
    recordAdminAccess(tx, {
      adminId: null,
      action: "admin.sign_in",
      ip: "203.0.113.10",
      outcome: "denied",
    }),
  );
  const { rows } = await t.pool.query(
    "select actor_type, actor_id, target_id, host(ip) as ip, metadata from audit_log where ip = '203.0.113.10'",
  );
  expect(rows).toEqual([
    {
      actor_type: "system",
      actor_id: null,
      target_id: null,
      ip: "203.0.113.10",
      metadata: { outcome: "denied" },
    },
  ]);
});

it("refuses an action outside its list, an outcome outside its list and an empty IP", async () => {
  for (const bad of [
    { adminId: null, action: "admin.delete_everything", ip: "203.0.113.9", outcome: "ok" },
    { adminId: null, action: "admin.sign_in", ip: "203.0.113.9", outcome: "free text" },
    { adminId: null, action: "admin.sign_in", ip: "", outcome: "ok" },
    { adminId: "not-a-uuid", action: "admin.sign_in", ip: "203.0.113.9", outcome: "ok" },
  ]) {
    await expect(asAdminRole((tx) => recordAdminAccess(tx, bad as never))).rejects.toBeInstanceOf(
      TypeError,
    );
  }
});
