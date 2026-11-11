import { sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ADMIN_ROLES, ADMIN_STATUSES } from "../../schema/admins";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /admins: list the admin users, create the record, set the role, disable and enable. Superadmin
// only (reads too). The Cognito side (invite, TOTP reset) is a port of the app; what is stored here is
// the record the app trusts on every request: admin_users.role and .status (6.1). Rules:
//  - the admin who acts is always the actor of the verified session (`scope.actor`), never an input;
//  - nobody changes their own role or disables themselves;
//  - the last active superadmin is never disabled or demoted (checked under a lock, so two superadmins
//    that remove each other at the same moment leave one);
//  - the same request twice is a replay (R7); every write goes through `audited` (R10).
const SUPERADMIN_ONLY: readonly AdminRole[] = ["superadmin"];
const MAX_SUB = 128;
const SUB = /^[A-Za-z0-9._:@-]+$/;
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;

export const DIRECTORY_ACTIONS = ["mfa_reset"] as const;

export interface AdminUserRow {
  id: string;
  // The Cognito sub: used by the app to ask the directory port, never shown.
  cognitoSub: string;
  role: AdminRole;
  status: "active" | "disabled";
  createdAt: Date;
}

export interface AdminUserListInput {
  role?: AdminRole;
  status?: "active" | "disabled";
  limit?: number;
  after?: string;
}

export interface AdminUserListResult {
  rows: AdminUserRow[];
  nextAfter: string | null;
}

export interface AdminUserChanged {
  id: string;
  role: AdminRole;
  status: "active" | "disabled";
}

export interface AdminUsersAdminRepo {
  list(input?: AdminUserListInput): Promise<Written<AdminUserListResult>>;
  detail(adminId: string): Promise<Written<AdminUserRow>>;
  create(
    input: { cognitoSub: string; role: AdminRole },
    reason: string,
  ): Promise<Written<AdminUserChanged>>;
  setRole(
    input: { adminId: string; role: AdminRole },
    reason: string,
  ): Promise<Written<AdminUserChanged>>;
  disable(input: { adminId: string }, reason: string): Promise<Written<AdminUserChanged>>;
  enable(input: { adminId: string }, reason: string): Promise<Written<AdminUserChanged>>;
  // The audit row of an action that happens only in the directory (a TOTP reset): no column changes.
  recordDirectoryAction(
    input: { adminId: string; kind: (typeof DIRECTORY_ACTIONS)[number] },
    reason: string,
  ): Promise<Written<{ id: string }>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("admin user action refused");
  }
}

type DbRow = {
  id: string;
  cognito_sub: string;
  role: string;
  status: string;
  created_at: Date;
};

const toRow = (r: DbRow): AdminUserRow => ({
  id: r.id,
  cognitoSub: r.cognito_sub,
  role: r.role as AdminRole,
  status: r.status as AdminUserRow["status"],
  createdAt: r.created_at,
});

const isRole = (v: unknown): v is AdminRole => (ADMIN_ROLES as readonly unknown[]).includes(v);

export function adminUsersAdminRepo(scope: AdminScope): AdminUsersAdminRepo {
  const { tx, actor } = scope;
  const isSuper = SUPERADMIN_ONLY.includes(actor.role);

  // Serialises every change of role or status; released at the end of the transaction. Taken before the
  // share lock of the actor row, so two superadmins cannot deadlock on each other's rows.
  const lockChanges = () =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('admin_users:changes', 0))`);

  const lockRow = async (id: string) => {
    const { rows } = await tx.execute<DbRow>(
      sql`select id, cognito_sub, role, status, created_at from admin_users where id = ${id} for update`,
    );
    const row = rows[0];
    if (row === undefined) throw new Refusal("not_found");
    return row;
  };

  // True when, after the change, an active superadmin other than `id` would remain.
  const otherActiveSuperadmin = async (id: string): Promise<boolean> => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from admin_users where role = 'superadmin' and status = 'active' and id <> ${id}`,
    );
    return Number(rows[0]?.n ?? "0") > 0;
  };

  const run = async <T>(
    action: string,
    targetId: string,
    reason: string,
    write: () => Promise<{ value: T; replayed: boolean; before: unknown; after: unknown }>,
  ): Promise<Written<T>> => {
    const note = typeof reason === "string" ? reason.trim() : "";
    try {
      return await audited(
        scope,
        { action, targetType: "admin_user", targetId, reason: note },
        write,
      );
    } catch (error) {
      if (error instanceof Refusal) return refused(error.code);
      throw error;
    }
  };

  const changed = (r: { id: string; role: string; status: string }): AdminUserChanged => ({
    id: r.id,
    role: r.role as AdminRole,
    status: r.status as AdminUserChanged["status"],
  });

  return {
    async list(input) {
      if (!isSuper || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { role, status, limit, after } = input ?? {};
      const size = limit === undefined ? PAGE_DEFAULT : limit;
      if (
        !Number.isInteger(size) ||
        size < 1 ||
        size > PAGE_MAX ||
        (role !== undefined && !isRole(role)) ||
        (status !== undefined && !(ADMIN_STATUSES as readonly unknown[]).includes(status)) ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const where: SQL[] = [sql`true`];
      if (role !== undefined) where.push(sql`role = ${role}`);
      if (status !== undefined) where.push(sql`status = ${status}`);
      if (after !== undefined) where.push(sql`id < ${after.toLowerCase()}`);
      const result = await tx.execute<DbRow>(
        sql`select id, cognito_sub, role, status, created_at from admin_users where ${sql.join(where, sql` and `)} order by id desc limit ${size + 1}`,
      );
      const page = result.rows.slice(0, size);
      return {
        ok: true,
        replayed: false,
        value: {
          rows: page.map(toRow),
          nextAfter: result.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    },

    async detail(adminId) {
      if (!isSuper || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof adminId !== "string" || !isUuid(adminId)) return refused("not_found");
      const { rows } = await tx.execute<DbRow>(
        sql`select id, cognito_sub, role, status, created_at from admin_users where id = ${adminId.toLowerCase()}`,
      );
      const row = rows[0];
      return row === undefined
        ? refused("not_found")
        : { ok: true, replayed: false, value: toRow(row) };
    },

    async create(input, reason) {
      if (!isSuper || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { cognitoSub, role } = input ?? ({} as never);
      if (
        typeof cognitoSub !== "string" ||
        cognitoSub === "" ||
        cognitoSub.length > MAX_SUB ||
        !SUB.test(cognitoSub) ||
        !isRole(role)
      ) {
        return refused("validation");
      }
      const id = uuidv7();
      // The audit target is the new id, or the id of the record the same sub already has.
      const existing = await tx.execute<{ id: string }>(
        sql`select id from admin_users where cognito_sub = ${cognitoSub}`,
      );
      const targetId = existing.rows[0]?.id ?? id;
      return run(`admin_user.create`, targetId, reason, async () => {
        await lockChanges();
        const { rows } = await tx.execute<{ id: string; role: string; status: string }>(
          sql`select id, role, status from admin_users where cognito_sub = ${cognitoSub} for update`,
        );
        const found = rows[0];
        if (found !== undefined) {
          if (found.role !== role) throw new Refusal("conflict");
          const same = { role: found.role, status: found.status };
          return { value: changed(found), replayed: true, before: same, after: same };
        }
        await tx.execute(
          sql`insert into admin_users (id, cognito_sub, role, status) values (${id}, ${cognitoSub}, ${role}, 'active')`,
        );
        return {
          value: { id, role, status: "active" } as AdminUserChanged,
          replayed: false,
          before: null,
          after: { role, status: "active" },
        };
      });
    },

    async setRole(input, reason) {
      if (!isSuper) return refused("forbidden");
      const { adminId, role } = input ?? ({} as never);
      if (typeof adminId !== "string" || !isUuid(adminId) || !isRole(role)) {
        return refused("validation");
      }
      const id = adminId.toLowerCase();
      // Nobody changes their own role, not even to the same one.
      if (id === actor.adminId.toLowerCase()) return refused("forbidden");
      await lockChanges();
      return run("admin_user.set_role", id, reason, async () => {
        const current = await lockRow(id);
        const before = { role: current.role, status: current.status };
        if (current.role === role) {
          return { value: changed(current), replayed: true, before, after: before };
        }
        if (
          current.role === "superadmin" &&
          current.status === "active" &&
          !(await otherActiveSuperadmin(id))
        ) {
          throw new Refusal("conflict");
        }
        await tx.execute(sql`update admin_users set role = ${role} where id = ${id}`);
        return {
          value: changed({ ...current, role }),
          replayed: false,
          before,
          after: { role, status: current.status },
        };
      });
    },

    async disable(input, reason) {
      if (!isSuper) return refused("forbidden");
      const adminId = input?.adminId;
      if (typeof adminId !== "string" || !isUuid(adminId)) return refused("validation");
      const id = adminId.toLowerCase();
      if (id === actor.adminId.toLowerCase()) return refused("forbidden");
      await lockChanges();
      return run("admin_user.disable", id, reason, async () => {
        const current = await lockRow(id);
        const before = { role: current.role, status: current.status };
        if (current.status === "disabled") {
          return { value: changed(current), replayed: true, before, after: before };
        }
        if (current.role === "superadmin" && !(await otherActiveSuperadmin(id))) {
          throw new Refusal("conflict");
        }
        await tx.execute(sql`update admin_users set status = 'disabled' where id = ${id}`);
        return {
          value: changed({ ...current, status: "disabled" }),
          replayed: false,
          before,
          after: { role: current.role, status: "disabled" },
        };
      });
    },

    async enable(input, reason) {
      if (!isSuper) return refused("forbidden");
      const adminId = input?.adminId;
      if (typeof adminId !== "string" || !isUuid(adminId)) return refused("validation");
      const id = adminId.toLowerCase();
      await lockChanges();
      return run("admin_user.enable", id, reason, async () => {
        const current = await lockRow(id);
        const before = { role: current.role, status: current.status };
        if (current.status === "active") {
          return { value: changed(current), replayed: true, before, after: before };
        }
        await tx.execute(sql`update admin_users set status = 'active' where id = ${id}`);
        return {
          value: changed({ ...current, status: "active" }),
          replayed: false,
          before,
          after: { role: current.role, status: "active" },
        };
      });
    },

    async recordDirectoryAction(input, reason) {
      if (!isSuper) return refused("forbidden");
      const { adminId, kind } = input ?? ({} as never);
      if (
        typeof adminId !== "string" ||
        !isUuid(adminId) ||
        !(DIRECTORY_ACTIONS as readonly unknown[]).includes(kind)
      ) {
        return refused("validation");
      }
      const id = adminId.toLowerCase();
      return run(`admin_user.${kind}`, id, reason, async () => {
        const { rows } = await tx.execute<{ role: string; status: string }>(
          sql`select role, status from admin_users where id = ${id}`,
        );
        const current = rows[0];
        if (current === undefined) throw new Refusal("not_found");
        return {
          value: { id },
          replayed: false,
          before: { role: current.role, status: current.status },
          after: { requested: kind },
        };
      });
    },
  };
}
