import type { AdminNavId, AdminRole } from "@tc/ui";

export const ADMIN_ROLES: readonly AdminRole[] = ["support", "finance", "ops", "superadmin"];

// Who may open each area of 16.12 (reading counts as opening; the actions of an area check their own,
// narrower roles when WP8 builds them). `superadmin` opens everything: the roles column of 16.12 names
// the working role and `superadmin` is the owner of the panel (6.2).
export const SECTION_ROLES: Readonly<Record<AdminNavId, readonly AdminRole[]>> = {
  today: ADMIN_ROLES,
  customers: ["support", "ops", "superadmin"],
  payments: ["finance", "superadmin"],
  pricing: ["finance", "superadmin"],
  catalog: ["ops", "superadmin"],
  capacity: ["ops", "superadmin"],
  operations: ["ops", "superadmin"],
  support: ["support", "superadmin"],
  abuse: ["ops", "support", "superadmin"],
  reconciliation: ["ops", "finance", "superadmin"],
  audit: ADMIN_ROLES,
  admins: ["superadmin"],
};

export const SECTION_IDS = Object.keys(SECTION_ROLES) as AdminNavId[];

export function canOpen(role: AdminRole, id: AdminNavId): boolean {
  return Object.hasOwn(SECTION_ROLES, id) && SECTION_ROLES[id].includes(role);
}

// The entries of the navigation for a role.
export function visibleIdsFor(role: AdminRole): AdminNavId[] {
  return SECTION_IDS.filter((id) => canOpen(role, id));
}

export function isSectionId(value: string): value is AdminNavId {
  return Object.hasOwn(SECTION_ROLES, value);
}

// Route segment of a section: the href of the nav entry without the slash. `today` is the root.
export function segmentOf(id: AdminNavId): string {
  return id === "today" ? "" : id;
}
