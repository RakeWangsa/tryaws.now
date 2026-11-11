import { check, pgTable, text, unique } from "drizzle-orm/pg-core";
import { createdAt, id, inList } from "./common";

export const ADMIN_ROLES = ["support", "finance", "ops", "superadmin"] as const;
export const ADMIN_STATUSES = ["active", "disabled"] as const;

export const adminUsers = pgTable(
  "admin_users",
  {
    id: id(),
    cognitoSub: text("cognito_sub").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("admin_users_cognito_sub_unique").on(t.cognitoSub),
    check("admin_users_role_check", inList(t.role, ADMIN_ROLES)),
    check("admin_users_status_check", inList(t.status, ADMIN_STATUSES)),
  ],
);
