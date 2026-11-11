import type { Tx } from "../../client";
import { insertAudit } from "../audit-log";
import { isUuid } from "../scope";

// The audit row of a sign-in or a sign-out of the admin app (R10). It is not a write of a setting, so
// it does not go through `audited` (that needs an active admin with a reason); it has a fixed list of
// actions and outcomes, so no free text reaches the table (R14): no email, no password, no code.
export const ADMIN_ACCESS_ACTIONS = ["admin.sign_in", "admin.sign_out"] as const;
export const ADMIN_ACCESS_OUTCOMES = [
  "ok",
  "denied",
  "invalid",
  "rate_limited",
  "ip_not_allowed",
  "unavailable",
] as const;

export interface AdminAccessEntry {
  // null for a sign-in that did not end in a session: the actor is then the system.
  adminId: string | null;
  action: (typeof ADMIN_ACCESS_ACTIONS)[number];
  ip: string;
  userAgent?: string;
  outcome: (typeof ADMIN_ACCESS_OUTCOMES)[number];
}

export async function recordAdminAccess(tx: Tx, entry: AdminAccessEntry): Promise<void> {
  const { adminId, action, ip, userAgent, outcome } = entry;
  if (
    !(ADMIN_ACCESS_ACTIONS as readonly unknown[]).includes(action) ||
    !(ADMIN_ACCESS_OUTCOMES as readonly unknown[]).includes(outcome) ||
    typeof ip !== "string" ||
    ip === "" ||
    (adminId !== null && (typeof adminId !== "string" || !isUuid(adminId)))
  ) {
    throw new TypeError("recordAdminAccess: the entry is not valid");
  }
  await insertAudit(tx, {
    actorType: adminId === null ? "system" : "admin",
    actorId: adminId,
    action,
    ...(adminId === null ? {} : { targetType: "admin", targetId: adminId }),
    ip,
    ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, 200) } : {}),
    metadata: { outcome },
  });
}
