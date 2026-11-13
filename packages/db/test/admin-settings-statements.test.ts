import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import type { AdminActor, AdminRole } from "../repositories/admin/index";
import {
  ADMIN_SETTING_KEYS,
  settingAuditFilter,
  settingsAdminRepo,
} from "../repositories/admin/settings";

// WPU-Z4: the settings repository of the admin app, without a database. A fake transaction renders every
// statement the repository sends (PgDialect) and answers from a small world, so these cases run where
// PostgreSQL cannot: every refusal comes before any statement, and a write sends exactly the row that the
// unpaid job reads (readSettings of repositories/system/lifecycle.ts: key, market, scope 'market',
// scope_id null, JSON true or false). The grants, the real rows and readSettings itself are proven against
// PostgreSQL in admin-settings.test.ts.

const dialect = new PgDialect();
const KEY = "lifecycle_unpaid_enabled";
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const ROW_ID = "0191a000-0000-7000-8000-0000000000e1";
const IP = "203.0.113.5";
const UA = "test-agent";

interface Sent {
  readonly sql: string;
  readonly params: unknown[];
}

interface World {
  /** The admin_users row of the actor; null when there is none. */
  admin: { role: string; status: string } | null;
  /** The settings row of the key and market; undefined when there is none. */
  stored: { id: string; value: unknown } | undefined;
}

function rig(role: AdminRole, over: Partial<World> = {}) {
  const world: World = { admin: { role, status: "active" }, stored: undefined, ...over };
  const sent: Sent[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      const text = rendered.sql.replace(/\s+/g, " ").trim();
      sent.push({ sql: text, params: rendered.params });
      if (text.startsWith("select role, status from admin_users")) {
        return { rows: world.admin === null ? [] : [world.admin] };
      }
      if (/^select (id, )?value from settings/.test(text)) {
        return { rows: world.stored === undefined ? [] : [world.stored] };
      }
      return { rows: [] };
    },
  } as unknown as Tx;
  const actor: AdminActor = { adminId: ADMIN_ID, role, ip: IP, userAgent: UA };
  return { sent, repo: settingsAdminRepo({ tx, actor }) };
}

const TARGET = { key: KEY, market: "BD" } as const;
const FORBIDDEN = { ok: false, error: "forbidden" };
const VALIDATION = { ok: false, error: "validation" };
const kindOf = (s: Sent): string =>
  s.sql.startsWith("select role, status from admin_users")
    ? "admin"
    : s.sql.includes("pg_advisory_xact_lock")
      ? "lock"
      : s.sql.startsWith("select")
        ? "select"
        : s.sql.startsWith("insert into settings")
          ? "insert"
          : s.sql.startsWith("update settings")
            ? "update"
            : s.sql.startsWith("insert into audit_log")
              ? "audit"
              : "other";
const onSettings = (sent: readonly Sent[]) => sent.filter((s) => /\bsettings\b/.test(s.sql));
const auditOf = (sent: readonly Sent[]) => {
  const audit = sent.find((s) => kindOf(s) === "audit");
  expect(audit, "an audit row").toBeDefined();
  return audit as Sent;
};
const metadataOf = (audit: Sent): unknown => JSON.parse(String(audit.params[8]));

describe("settingsAdminRepo: refusals before any statement", () => {
  it("the allow-list holds only the switch of the unpaid-usage job", () => {
    expect(ADMIN_SETTING_KEYS).toEqual([KEY]);
  });

  it("turning on is superadmin only: ops, finance and support are refused before any statement", async () => {
    for (const role of ["ops", "finance", "support"] as const) {
      const r = rig(role);
      expect(await r.repo.setBoolean(TARGET, true, "go live"), role).toEqual(FORBIDDEN);
      expect(r.sent, role).toEqual([]);
    }
  });

  it("turning off is ops or superadmin: finance and support are refused before any statement", async () => {
    for (const role of ["finance", "support"] as const) {
      const r = rig(role);
      expect(await r.repo.setBoolean(TARGET, false, "stop"), role).toEqual(FORBIDDEN);
      expect(r.sent, role).toEqual([]);
    }
  });

  it("a value that is not exactly false asks for the roles of turning on (R16)", async () => {
    for (const value of ["false", 0, null, undefined, "true", 1]) {
      const ops = rig("ops");
      expect(await ops.repo.setBoolean(TARGET, value as never, "r"), String(value)).toEqual(
        FORBIDDEN,
      );
      expect(ops.sent).toEqual([]);
      const superadmin = rig("superadmin");
      expect(await superadmin.repo.setBoolean(TARGET, value as never, "r"), String(value)).toEqual(
        VALIDATION,
      );
      expect(superadmin.sent).toEqual([]);
    }
  });

  it("a key off the allow-list and a market that is not two capital letters are refused before any statement", async () => {
    const keys = ["tier_limits", "r13_approval_until", "invoice_seller", "", "__proto__", 7];
    for (const key of keys) {
      const write = rig("superadmin");
      expect(await write.repo.setBoolean({ key, market: "BD" } as never, false, "r")).toEqual(
        VALIDATION,
      );
      expect(write.sent).toEqual([]);
      const read = rig("support");
      expect(await read.repo.read(key as never, "BD")).toEqual(VALIDATION);
      expect(read.sent).toEqual([]);
    }
    for (const market of ["bd", "BDT", "", "B", null]) {
      const write = rig("superadmin");
      expect(await write.repo.setBoolean({ key: KEY, market } as never, true, "r")).toEqual(
        VALIDATION,
      );
      expect(write.sent).toEqual([]);
      const read = rig("finance");
      expect(await read.repo.read(KEY, market as never)).toEqual(VALIDATION);
      expect(read.sent).toEqual([]);
    }
  });

  it("a role that is not an admin role reads nothing, before any statement", async () => {
    const r = rig("guest" as never);
    expect(await r.repo.read(KEY, "BD")).toEqual(FORBIDDEN);
    expect(r.sent).toEqual([]);
  });

  it("a disabled admin, a missing admin and an actor whose role is not the row's stop at the admin check", async () => {
    const cases: Partial<World>[] = [
      { admin: { role: "superadmin", status: "disabled" } },
      { admin: null },
      { admin: { role: "support", status: "active" } },
    ];
    for (const over of cases) {
      const write = rig("superadmin", over);
      expect(await write.repo.setBoolean(TARGET, true, "go live")).toEqual(FORBIDDEN);
      expect(write.sent.map(kindOf)).toEqual(["admin"]);
      const read = rig("superadmin", over);
      expect(await read.repo.read(KEY, "BD")).toEqual(FORBIDDEN);
      expect(read.sent.map(kindOf)).toEqual(["admin"]);
    }
  });

  it("a blank or too long reason is refused after the admin check: nothing is written", async () => {
    for (const reason of ["", "   ", "x".repeat(501)]) {
      const r = rig("superadmin");
      expect(await r.repo.setBoolean(TARGET, true, reason)).toEqual(VALIDATION);
      expect(onSettings(r.sent)).toEqual([]);
      expect(r.sent.map(kindOf)).toEqual(["admin"]);
    }
  });
});

describe("settingsAdminRepo.setBoolean: the row of the job, through audited", () => {
  it("turning on without a row inserts exactly the row that readSettings reads", async () => {
    const r = rig("superadmin");
    expect(await r.repo.setBoolean(TARGET, true, "  pilot customers  ")).toEqual({
      ok: true,
      replayed: false,
      value: { key: KEY, market: "BD", enabled: true },
    });
    // Admin check, the lock of the key and market, the read of the row, the write, the audit row.
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "select", "insert", "audit"]);
    const lock = r.sent[1] as Sent;
    expect(lock.params).toEqual([`settings.${KEY}:BD`]);
    const select = r.sent[2] as Sent;
    expect(select.sql).toBe(
      "select id, value from settings where key = $1 and market = $2 and scope = 'market' and scope_id is null limit 1",
    );
    expect(select.params).toEqual([KEY, "BD"]);
    const insert = r.sent[3] as Sent;
    expect(insert.sql).toBe(
      "insert into settings (id, key, market, scope, scope_id, value, set_by) values ($1, $2, $3, 'market', null, $4::jsonb, $5)",
    );
    expect(insert.params).toEqual([expect.any(String), KEY, "BD", "true", ADMIN_ID]);
    expect(String(insert.params[0])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it("the audit row holds actor, IP, target setting:<market>:<key>, the reason and before/after", async () => {
    const r = rig("superadmin");
    await r.repo.setBoolean(TARGET, true, "pilot customers");
    const audit = auditOf(r.sent);
    expect(audit.params.slice(1, 8)).toEqual([
      "admin",
      ADMIN_ID,
      "setting.set",
      "setting",
      `BD:${KEY}`,
      IP,
      UA,
    ]);
    expect(metadataOf(audit)).toEqual({
      reason: "pilot customers",
      before: null,
      after: { value: true },
    });
    expect(settingAuditFilter("BD", KEY)).toEqual({
      action: "setting.set",
      targetType: "setting",
      targetId: `BD:${KEY}`,
    });
  });

  it("the same value again is a replay: no insert, no update, and before equals after", async () => {
    for (const value of [true, false]) {
      const r = rig("superadmin", { stored: { id: ROW_ID, value } });
      expect(await r.repo.setBoolean(TARGET, value, "again")).toEqual({
        ok: true,
        replayed: true,
        value: { key: KEY, market: "BD", enabled: value },
      });
      expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "select", "audit"]);
      expect(metadataOf(auditOf(r.sent))).toEqual({
        reason: "again",
        before: { value },
        after: { value },
      });
    }
  });

  it("ops turns it off: the row is updated in place, set_by is the admin, the old value stays in the audit row", async () => {
    const r = rig("ops", { stored: { id: ROW_ID, value: true } });
    expect(await r.repo.setBoolean(TARGET, false, "too many suspensions")).toEqual({
      ok: true,
      replayed: false,
      value: { key: KEY, market: "BD", enabled: false },
    });
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "select", "update", "audit"]);
    const update = r.sent[3] as Sent;
    expect(update.sql).toBe("update settings set value = $1::jsonb, set_by = $2 where id = $3");
    expect(update.params).toEqual(["false", ADMIN_ID, ROW_ID]);
    expect(metadataOf(auditOf(r.sent))).toEqual({
      reason: "too many suspensions",
      before: { value: true },
      after: { value: false },
    });
  });

  it("a stored value that is not a boolean is replaced, never a replay, and kept in the audit row", async () => {
    const r = rig("ops", { stored: { id: ROW_ID, value: "false" } });
    expect(await r.repo.setBoolean(TARGET, false, "clean up")).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "select", "update", "audit"]);
    expect(metadataOf(auditOf(r.sent))).toMatchObject({ before: { value: "false" } });
  });
});

describe("settingsAdminRepo.read: the answer of the job", () => {
  it("every admin role reads; the WHERE is the one of readSettings", async () => {
    for (const role of ["support", "finance", "ops", "superadmin"] as const) {
      const r = rig(role, { stored: { id: ROW_ID, value: true } });
      expect(await r.repo.read(KEY, "BD"), role).toEqual({
        ok: true,
        replayed: false,
        value: { key: KEY, market: "BD", enabled: true, source: "stored" },
      });
      expect(r.sent.map(kindOf)).toEqual(["admin", "select"]);
      expect(r.sent[1]?.sql).toBe(
        "select value from settings where key = $1 and market = $2 and scope = 'market' and scope_id is null limit 1",
      );
      expect(r.sent[1]?.params).toEqual([KEY, "BD"]);
    }
  });

  it("only a stored JSON true is on; no row is off; any other stored value is off and invalid", async () => {
    const cases: [World["stored"], boolean, string][] = [
      [undefined, false, "none"],
      [{ id: ROW_ID, value: false }, false, "stored"],
      [{ id: ROW_ID, value: true }, true, "stored"],
      [{ id: ROW_ID, value: "true" }, false, "invalid"],
      [{ id: ROW_ID, value: 1 }, false, "invalid"],
      [{ id: ROW_ID, value: null }, false, "invalid"],
      [{ id: ROW_ID, value: { on: true } }, false, "invalid"],
    ];
    for (const [stored, enabled, source] of cases) {
      const r = rig("support", { stored });
      expect(await r.repo.read(KEY, "BD"), JSON.stringify(stored)).toMatchObject({
        ok: true,
        value: { enabled, source },
      });
    }
  });
});
