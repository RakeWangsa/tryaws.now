import { maskEmail, type AdminActor, type AdminRepos, type AdminRole } from "@tc/db";
import type { Loaded } from "./money-data.ts";
import { adminDirectory, readAsAdmin } from "./runtime.ts";

// The read of /admins: the admin_users records from the database, then the facts that only the Cognito
// pool has (email, last sign-in, TOTP) from the directory port. A directory that does not answer leaves
// those cells empty and says so; it never hides the records. The email is shown masked (R14); the
// Cognito sub is used here and is not part of the result.
export interface AdminListRow {
  readonly id: string;
  readonly role: AdminRole;
  readonly status: "active" | "disabled";
  readonly createdAt: Date;
  readonly email: string | null;
  readonly lastSignInAt: Date | null;
  readonly totpEnrolled: boolean | null;
}

export interface AdminListView {
  readonly rows: AdminListRow[];
  readonly nextAfter: string | null;
  readonly directory: "ok" | "off";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adminsAfterOf(raw: Record<string, string | string[] | undefined>): string | null {
  const after = typeof raw["after"] === "string" ? raw["after"] : "";
  return UUID.test(after) ? after.toLowerCase() : null;
}

export async function loadAdmins(
  admin: AdminActor,
  after: string | null,
): Promise<Loaded<AdminListView>> {
  let page;
  try {
    page = await readAsAdmin(admin, (repos: AdminRepos) =>
      repos.adminUsers.list({ limit: 50, ...(after === null ? {} : { after }) }),
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (!page.ok) return { kind: "unavailable" };
  let facts: Awaited<ReturnType<ReturnType<typeof adminDirectory>["describe"]>> | null = null;
  try {
    facts = await adminDirectory().describe(page.value.rows.map((r) => r.cognitoSub));
  } catch {
    facts = null;
  }
  return {
    kind: "ok",
    value: {
      directory: facts === null ? "off" : "ok",
      nextAfter: page.value.nextAfter,
      rows: page.value.rows.map((r) => {
        const f = facts?.get(r.cognitoSub);
        return {
          id: r.id,
          role: r.role,
          status: r.status,
          createdAt: r.createdAt,
          email: f === undefined ? null : maskEmail(f.email),
          lastSignInAt: f?.lastSignInAt ?? null,
          totpEnrolled: f === undefined ? null : f.totpEnrolled,
        };
      }),
    },
  };
}
