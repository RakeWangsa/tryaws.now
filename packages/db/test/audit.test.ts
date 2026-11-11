import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { insertAudit, type AuditEntry } from "../repositories/audit-log";
import type { CustomerAuditInput } from "../repositories/customer/audit";
import { auditRowsOf, withCustomerRepos } from "../testing/repos";
import { runTransaction, type DatabaseRole } from "../tx";
import { useTempDatabase } from "./temp-db";
import { newCustomer } from "./fixtures";

const t = useTempDatabase();

it("audit.record always records the session customer as the actor", async () => {
  const c = await newCustomer(t.pool);
  const r = await withCustomerRepos(t.db, c, (x) =>
    x.audit.record({
      action: "ssh_key.add",
      targetType: "ssh_key",
      targetId: uuidv7(),
      ip: "2001:db8::1",
    }),
  );
  expect(r).toMatchObject({ ok: true, replayed: false });
  expect(await auditRowsOf(t.pool, c)).toMatchObject([
    { actor_type: "customer", action: "ssh_key.add", ip: "2001:db8::1" },
  ]);
  for (const action of ["", "Add", "add", "x." + "y".repeat(64)]) {
    expect(await withCustomerRepos(t.db, c, (x) => x.audit.record({ action }))).toEqual({
      ok: false,
      error: "validation",
    });
  }
});

it("a bad IP fails in the database and the whole transaction rolls back (R16)", async () => {
  const c = await newCustomer(t.pool);
  await expect(
    withCustomerRepos(t.db, c, async (x) => {
      await x.audit.record({ action: "ssh_key.add" });
      return x.audit.record({ action: "ssh_key.add", ip: "not-an-ip" });
    }),
  ).rejects.toMatchObject({ name: "DbError", code: "22P02" });
  expect(await auditRowsOf(t.pool, c)).toEqual([]);
});

// The input has no actor field, but a cast input, or a form that was not validated, might carry one.
it("audit.record takes the actor from the scope, whatever a cast input carries", async () => {
  const c = await newCustomer(t.pool);
  const other = await newCustomer(t.pool);
  const cast = { action: "ssh_key.add", actorType: "admin", actorId: other } as CustomerAuditInput;
  expect(await withCustomerRepos(t.db, c, (x) => x.audit.record(cast))).toMatchObject({ ok: true });
  expect(await auditRowsOf(t.pool, other)).toEqual([]);
  expect(await auditRowsOf(t.pool, c)).toMatchObject([
    { actor_type: "customer", action: "ssh_key.add" },
  ]);
});

it("audit.record accepts an action of 64 characters and refuses what is not area.verb", async () => {
  const c = await newCustomer(t.pool);
  const record = (action: unknown) =>
    withCustomerRepos(t.db, c, (x) => x.audit.record({ action } as CustomerAuditInput));
  const named = (length: number) => "a." + "b".repeat(length - 2);
  for (const action of [named(64), "profile.update", "order.place_v2", "a.b.c"]) {
    expect(await record(action)).toMatchObject({ ok: true });
  }
  const refusals = [
    named(65),
    "a.",
    ".a",
    "a..b",
    "a.B",
    "1a.b",
    "a-b.c",
    "a b.c",
    "ssh_key.add ",
    "ssh_key.add\n",
    // Not strings: the last one would pass the pattern through its toString.
    undefined,
    null,
    42,
    { toString: () => "ssh_key.add" },
  ];
  for (const action of refusals) {
    expect(await record(action)).toEqual({ ok: false, error: "validation" });
  }
  expect(await auditRowsOf(t.pool, c)).toHaveLength(4);
});

it("audit.record stores every field it is given and leaves the others empty; it has no key (open point 14)", async () => {
  const c = await newCustomer(t.pool);
  const target = uuidv7();
  const metadata = { reason: "rotated", before: { locale: "bn" }, after: { locale: "en" } };
  await withCustomerRepos(t.db, c, (x) =>
    x.audit.record({
      action: "profile.update",
      targetType: "profile",
      targetId: target,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
      metadata,
    }),
  );
  // The same call twice: two rows, two different ids, both new (no replay).
  const first = await withCustomerRepos(t.db, c, (x) => x.audit.record({ action: "ssh_key.add" }));
  const second = await withCustomerRepos(t.db, c, (x) => x.audit.record({ action: "ssh_key.add" }));
  expect(first).toMatchObject({ ok: true, replayed: false });
  expect(second).toMatchObject({ ok: true, replayed: false });
  expect(second).not.toEqual(first);
  const bare = {
    actor_type: "customer",
    action: "ssh_key.add",
    target_type: null,
    target_id: null,
    ip: null,
    user_agent: null,
    metadata: {},
  };
  expect(await auditRowsOf(t.pool, c)).toEqual([
    {
      actor_type: "customer",
      action: "profile.update",
      target_type: "profile",
      target_id: target,
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0",
      metadata,
    },
    bare,
    bare,
  ]);
});

// audited (Task 10) writes as admin_rw, the workers as worker_rw, the customer actions as web_rw: the
// narrow insert without RETURNING works for all three, although two of them cannot read the table.
it("insertAudit writes the entry and returns the id of the row, as each role that may write audit rows", async () => {
  const roles: DatabaseRole[] = ["web_rw", "admin_rw", "worker_rw"];
  const entry: AuditEntry = {
    actorType: "system",
    actorId: null,
    action: "capacity.recount",
    metadata: { pool: "p1" },
  };
  const ids: string[] = [];
  for (const role of roles) {
    const id = await runTransaction(t.db, (tx) => insertAudit(tx, entry), { role });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    ids.push(id);
    const { rows } = await t.pool.query(
      "select actor_type, actor_id, action, target_type, ip, metadata from audit_log where id = $1",
      [id],
    );
    expect(rows).toEqual([
      {
        actor_type: "system",
        actor_id: null,
        action: "capacity.recount",
        target_type: null,
        ip: null,
        metadata: { pool: "p1" },
      },
    ]);
  }
  expect(new Set(ids).size).toBe(roles.length);
});

it("insertAudit leaves the actor check of the table to the database: a customer entry without an actor id fails", async () => {
  const entry: AuditEntry = { actorType: "customer", actorId: null, action: "ssh_key.add" };
  await expect(
    runTransaction(t.db, (tx) => insertAudit(tx, entry), { role: "web_rw" }),
  ).rejects.toMatchObject({
    name: "DbError",
    code: "23514",
    constraint: "audit_log_actor_check",
  });
});
