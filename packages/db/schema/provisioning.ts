import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./admins";
import { catalogProducts } from "./catalog";
import { createdAt, id, inList } from "./common";
import { customers } from "./identity";

// The ten quota codes of section 10.2.
export const QUOTA_CODES = [
  "instance_vcpu",
  "static_ip",
  "database",
  "load_balancer",
  "container_service",
  "certificate_active",
  "certificate_365d",
  "disk_gb",
  "bucket",
  "distribution",
] as const;

// Section 7.
export const RESOURCE_STATES = [
  "creating",
  "active",
  "stopped",
  "suspended",
  "destroyed",
  "failed",
] as const;

// Section 10.1.
export const OPERATION_STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "needs_approval",
  "needs_attention",
] as const;

// Section 11.
export const SUBSCRIPTION_STATUSES = ["active", "grace", "retained", "ended"] as const;

export const poolAccounts = pgTable(
  "pool_accounts",
  {
    id: id(),
    awsAccountId: text("aws_account_id").notNull(),
    name: text("name").notNull(),
    tier: text("tier").notNull(),
    roleArn: text("role_arn").notNull(),
    // A plain value (6.3), not a secret.
    externalId: text("external_id").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pool_accounts_aws_account_id_unique").on(t.awsAccountId),
    unique("pool_accounts_name_unique").on(t.name),
    check("pool_accounts_aws_account_id_check", sql`${t.awsAccountId} ~ '^[0-9]{12}$'`),
  ],
);

export const poolCapacity = pgTable(
  "pool_capacity",
  {
    id: id(),
    poolAccountId: uuid("pool_account_id")
      .notNull()
      .references(() => poolAccounts.id),
    region: text("region").notNull(),
    quotaCode: text("quota_code").notNull(),
    // "limit" is a reserved word in SQL.
    quotaLimit: integer("quota_limit").notNull(),
    // No CHECK against the limit: the hourly inventory may record a live count above it.
    used: integer("used").notNull().default(0),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pool_capacity_pool_account_id_region_quota_code_unique").on(
      t.poolAccountId,
      t.region,
      t.quotaCode,
    ),
    check("pool_capacity_quota_code_check", inList(t.quotaCode, QUOTA_CODES)),
    check("pool_capacity_quota_limit_check", sql`${t.quotaLimit} >= 0`),
    check("pool_capacity_used_check", sql`${t.used} >= 0`),
  ],
);

export const customerHomes = pgTable(
  "customer_homes",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    region: text("region").notNull(),
    poolAccountId: uuid("pool_account_id")
      .notNull()
      .references(() => poolAccounts.id),
    createdAt: createdAt(),
  },
  (t) => [unique("customer_homes_customer_id_region_unique").on(t.customerId, t.region)],
);

export const resources = pgTable(
  "resources",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    // `backup` for each manual or final snapshot.
    family: text("family").notNull(),
    // NULL for a backup.
    productId: uuid("product_id").references(() => catalogProducts.id),
    // NULL for DNS and domains, which live in tc-dns.
    poolAccountId: uuid("pool_account_id").references(() => poolAccounts.id),
    region: text("region"),
    // R11 names are platform-wide.
    awsName: text("aws_name"),
    state: text("state").notNull().default("creating"),
    parentResourceId: uuid("parent_resource_id").references((): AnyPgColumn => resources.id),
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("resources_aws_name_unique").on(t.awsName),
    index("resources_customer_id_idx").on(t.customerId),
    index("resources_parent_resource_id_idx").on(t.parentResourceId),
    check("resources_state_check", inList(t.state, RESOURCE_STATES)),
    // Decided here: deleted_at is set exactly when the state is destroyed.
    check(
      "resources_deleted_check",
      sql`(${t.state} = 'destroyed') = (${t.deletedAt} IS NOT NULL)`,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    termDays: integer("term_days").notNull(),
    priceSnapshot: jsonb("price_snapshot").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    // Off means no charge without consent.
    autoRenew: boolean("auto_renew").notNull().default(false),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("subscriptions_resource_id_unique").on(t.resourceId),
    index("subscriptions_customer_id_idx").on(t.customerId),
    check("subscriptions_term_days_check", sql`${t.termDays} > 0`),
    check("subscriptions_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
    check("subscriptions_status_check", inList(t.status, SUBSCRIPTION_STATUSES)),
  ],
);

export const operations = pgTable(
  "operations",
  {
    id: id(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    // The values belong to OperationKind.
    kind: text("kind").notNull(),
    state: text("state").notNull().default("queued"),
    step: text("step"),
    attempts: integer("attempts").notNull().default(0),
    enqueueSeq: integer("enqueue_seq").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Ruling 5: set when the row is created; the trigger of Task 8 keeps it fixed (ruling 6).
    needsApproval: boolean("needs_approval").notNull().default(false),
    approvedBy: uuid("approved_by").references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("operations_idempotency_key_unique").on(t.idempotencyKey),
    index("operations_resource_id_idx").on(t.resourceId),
    index("operations_state_next_run_at_idx").on(t.state, t.nextRunAt),
    check("operations_state_check", inList(t.state, OPERATION_STATES)),
    check("operations_attempts_check", sql`${t.attempts} >= 0`),
    check("operations_enqueue_seq_check", sql`${t.enqueueSeq} >= 0`),
    check(
      "operations_needs_approval_state_check",
      sql`${t.state} <> 'needs_approval' OR ${t.needsApproval}`,
    ),
    check("operations_approved_by_check", sql`${t.approvedBy} IS NULL OR ${t.needsApproval}`),
    // Ruling 6, R13: without an approver the operation can only wait or be rejected.
    check(
      "operations_unapproved_state_check",
      sql`NOT ${t.needsApproval} OR ${t.approvedBy} IS NOT NULL OR ${t.state} IN ('needs_approval', 'failed')`,
    ),
  ],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    metric: text("metric").notNull(),
    // An ISO date or hour as text, the same text as in the key meter:<resource>:<metric>:<period>.
    period: text("period").notNull(),
    // Not money: GB and GB-days.
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("usage_records_resource_id_metric_period_unique").on(t.resourceId, t.metric, t.period),
    check("usage_records_period_check", sql`length(${t.period}) > 0`),
    check("usage_records_quantity_check", sql`${t.quantity} >= 0`),
  ],
);
