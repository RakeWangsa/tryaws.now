import { check, pgTable, text, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, id } from "./common";

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
    check("admin_users_role_check", sql`${t.role} in ('support', 'finance', 'ops', 'superadmin')`),
    check("admin_users_status_check", sql`${t.status} in ('active', 'disabled')`),
  ],
);
