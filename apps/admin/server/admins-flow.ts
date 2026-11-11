import type { AdminActor, AdminRepos, AdminRole } from "@tc/db";
import type { AdminDirectory } from "./admin-directory.ts";

// The actions of /admins in the order of R9: authenticate and authorize (superadmin only), validate,
// rate limit, execute (one transaction, every write through `audited`, which appends the audit row with
// actor, reason, IP and target), and the answer. The acting admin is the verified session admin and
// nothing in the request can name another one (a request has no actor or approver field). No next/*
// import here: the Server Action in admins-actions.ts wires the real pieces, so every step is tested
// with fakes. The Cognito side is the `directory` port. Answers are fixed codes (R14, R16).

export type AdminsActionKind =
  "inviteAdmin" | "setAdminRole" | "disableAdmin" | "enableAdmin" | "resetAdminMfa";

export interface AdminsActionRequest {
  readonly kind: AdminsActionKind;
  // The target admin (not for inviteAdmin).
  readonly id?: unknown;
  readonly email?: unknown;
  readonly role?: unknown;
  readonly reason: unknown;
}

export type AdminsActionCode =
  "invalid" | "denied" | "not_found" | "conflict" | "self" | "rate_limited" | "unavailable";

export type AdminsActionAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly targetId: string;
      // Whether the directory (Cognito) was told: "failed" means the database change stands.
      readonly directory: "done" | "failed";
    }
  | { readonly ok: false; readonly code: AdminsActionCode };

export interface AdminsFlowDeps {
  // requireAdmin(roles): rejects when there is no admin session or the role is not in the list.
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  readonly directory: AdminDirectory;
  readonly clock: { now(): Date };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const ROLES: readonly AdminRole[] = ["support", "finance", "ops", "superadmin"];
const KINDS: readonly AdminsActionKind[] = [
  "inviteAdmin",
  "setAdminRole",
  "disableAdmin",
  "enableAdmin",
  "resetAdminMfa",
];
export const MAX_REASON = 500;
const MAX_EMAIL = 254;

interface Valid {
  readonly kind: AdminsActionKind;
  readonly reason: string;
  readonly id: string | null;
  readonly email: string | null;
  readonly role: AdminRole | null;
}

function validate(request: AdminsActionRequest): Valid | null {
  const { kind, id, email, role, reason } = request;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  if (typeof reason !== "string") return null;
  const cleanReason = reason.trim();
  if (cleanReason === "" || cleanReason.length > MAX_REASON) return null;
  const out = { kind, reason: cleanReason, id: null, email: null, role: null } as {
    -readonly [K in keyof Valid]: Valid[K];
  };
  if (kind === "inviteAdmin") {
    if (typeof email !== "string") return null;
    const clean = email.trim().toLowerCase();
    if (clean.length > MAX_EMAIL || !EMAIL.test(clean)) return null;
    out.email = clean;
  } else {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    out.id = id.toLowerCase();
  }
  if (kind === "inviteAdmin" || kind === "setAdminRole") {
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return null;
    out.role = role as AdminRole;
  }
  return out;
}

type Outcome =
  | { ok: true; value: { id: string }; replayed: boolean; sub: string | null; enabled?: boolean }
  | { ok: false; error: "not_found" | "conflict" | "validation" | "forbidden" };

export function makeAdminsAction(
  deps: AdminsFlowDeps,
): (request: AdminsActionRequest) => Promise<AdminsActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read. Only these
    // fields are read: anything else a caller adds is ignored.
    const snapshot: AdminsActionRequest = {
      kind: request.kind,
      id: request.id,
      email: request.email,
      role: request.role,
      reason: request.reason,
    };
    // 1 and 2. Authenticate and authorize: superadmin only, for every kind.
    let actor: AdminActor;
    try {
      actor = await deps.authorize(["superadmin"]);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      const input = validate(snapshot);
      if (input === null) return { ok: false, code: "invalid" };
      // Nobody changes their own role or disables themselves; the repository refuses it as well.
      if (
        input.id === actor.adminId.toLowerCase() &&
        (input.kind === "setAdminRole" || input.kind === "disableAdmin")
      ) {
        return { ok: false, code: "self" };
      }
      // 4. Rate limit.
      if (!(await deps.limiter(actor, deps.clock.now())))
        return { ok: false, code: "rate_limited" };
      // The invitation comes first: the record needs the sub that the pool returns. If the pool cannot
      // answer, nothing is written (R16).
      let invitedSub: string | null = null;
      if (input.kind === "inviteAdmin") {
        try {
          invitedSub = (await deps.directory.invite(input.email as string)).sub;
        } catch {
          return { ok: false, code: "unavailable" };
        }
      }
      // 5 and 6. Execute and audit, in one transaction.
      const outcome = await deps.run<Outcome>(actor, async (repos) => {
        const users = repos.adminUsers;
        const subOf = async (id: string): Promise<string | null> => {
          const found = await users.detail(id);
          return found.ok ? found.value.cognitoSub : null;
        };
        switch (input.kind) {
          case "inviteAdmin": {
            const made = await users.create(
              { cognitoSub: invitedSub as string, role: input.role as AdminRole },
              input.reason,
            );
            return made.ok ? { ...made, sub: invitedSub } : made;
          }
          case "setAdminRole": {
            const done = await users.setRole(
              { adminId: input.id as string, role: input.role as AdminRole },
              input.reason,
            );
            return done.ok ? { ...done, sub: null } : done;
          }
          case "disableAdmin": {
            const done = await users.disable({ adminId: input.id as string }, input.reason);
            return done.ok
              ? { ...done, sub: await subOf(input.id as string), enabled: false }
              : done;
          }
          case "enableAdmin": {
            const done = await users.enable({ adminId: input.id as string }, input.reason);
            return done.ok
              ? { ...done, sub: await subOf(input.id as string), enabled: true }
              : done;
          }
          case "resetAdminMfa": {
            const done = await users.recordDirectoryAction(
              { adminId: input.id as string, kind: "mfa_reset" },
              input.reason,
            );
            return done.ok ? { ...done, sub: await subOf(input.id as string) } : done;
          }
        }
      });
      if (!outcome.ok) {
        if (outcome.error === "forbidden") return { ok: false, code: "denied" };
        if (outcome.error === "validation") return { ok: false, code: "invalid" };
        return { ok: false, code: outcome.error };
      }
      // The database is what the app trusts on every request (admin_users.status); the directory is
      // told after the commit. A replay tells it again, which repairs an earlier failure.
      let directory: "done" | "failed" = "done";
      if (outcome.enabled !== undefined || input.kind === "resetAdminMfa") {
        try {
          if (outcome.sub === null) throw new Error("no sub");
          if (input.kind === "resetAdminMfa") await deps.directory.resetMfa(outcome.sub);
          else await deps.directory.setEnabled(outcome.sub, outcome.enabled as boolean);
        } catch {
          if (input.kind === "resetAdminMfa") return { ok: false, code: "unavailable" };
          directory = "failed";
        }
      }
      return { ok: true, replayed: outcome.replayed, targetId: outcome.value.id, directory };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
