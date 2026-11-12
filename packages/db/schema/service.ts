import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./admins";
import { tlds } from "./catalog";
import { bytea, createdAt, id, inList } from "./common";
import { customers } from "./identity";
import { resources } from "./provisioning";

// Decided here: the channels of 12 and the states of a notification (`pending` is from section F).
export const NOTIFICATION_CHANNELS = ["email", "sms", "in_app"] as const;
export const NOTIFICATION_STATUSES = ["pending", "sent", "failed"] as const;
export const WAITLIST_REASONS = ["capacity", "flag_off"] as const;
// 16.12: replyByEmail and closeRequest; openAbuseCase and closeAbuseCase.
// WPU-G6: the words of dns_zones.status; the same list is DNS_ZONE_STATES of packages/core/dns.
export const DNS_ZONE_STATUSES = [
  "pending",
  "pending_delegation",
  "delegated",
  "removing",
  "removed",
  "failed",
] as const;
// WPU-B2: the words of domains.status; the same list is DOMAIN_STATES of packages/core/domains.
export const DOMAIN_STATUSES = [
  "pending",
  "review",
  "awaiting_verification",
  "registered",
  "failed",
  "expired",
] as const;
export const CASE_STATUSES = ["open", "closed"] as const;
export const DISCREPANCY_KINDS = ["orphan", "missing", "cost", "payment"] as const;
// 16.12: resolveDiscrepancy.
export const DISCREPANCY_STATUSES = ["open", "resolved"] as const;
// Decided here: the three kinds of actor, the same list as ledger_transactions.actor_type.
export const AUDIT_ACTOR_TYPES = ["customer", "admin", "system"] as const;

export const domains = pgTable(
  "domains",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    // A domain is a resource of family `domain` (10.3).
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    name: text("name").notNull(),
    tld: text("tld")
      .notNull()
      .references(() => tlds.tld),
    route53OperationId: text("route53_operation_id"),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    hostedZoneId: text("hosted_zone_id"),
    // The encrypted contact JSON.
    registrantContactEncrypted: bytea("registrant_contact_encrypted"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("domains_resource_id_unique").on(t.resourceId),
    index("domains_customer_id_idx").on(t.customerId),
    index("domains_name_idx").on(t.name),
    // WPU-B2: one ACTIVE order for a name on the whole platform. A failed order (reversed) gives the
    // name back; every other status holds it, an expired name included (the registry keeps it).
    uniqueIndex("domains_name_active_unique")
      .on(t.name)
      .where(sql`${t.status} <> 'failed'`),
    check("domains_status_check", inList(t.status, DOMAIN_STATUSES)),
  ],
);

export const dnsZones = pgTable(
  "dns_zones",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    name: text("name").notNull(),
    hostedZoneId: text("hosted_zone_id"),
    nameServers: text("name_servers")
      .array()
      .notNull()
      .default(sql`'{}'`),
    delegatedAt: timestamp("delegated_at", { withTimezone: true }),
    status: text("status").notNull(),
    // One time per notice (12 sends two).
    noticesSentAt: timestamp("notices_sent_at", { withTimezone: true })
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAt(),
  },
  (t) => [
    unique("dns_zones_resource_id_unique").on(t.resourceId),
    unique("dns_zones_hosted_zone_id_unique").on(t.hostedZoneId),
    index("dns_zones_customer_id_idx").on(t.customerId),
    // WPU-S1: one DELEGATED zone for a name on the whole platform. A zone is harmless until the
    // domain's NS records point at it, so several customers may hold a pending zone for one name; a
    // removed or failed zone gives the name back.
    uniqueIndex("dns_zones_name_delegated_unique")
      .on(t.name)
      .where(sql`${t.status} = 'delegated'`),
    check("dns_zones_status_check", inList(t.status, DNS_ZONE_STATUSES)),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    customerId: uuid("customer_id").references(() => customers.id),
    // For visitors.
    email: text("email"),
    channel: text("channel").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("notifications_dedupe_key_unique").on(t.dedupeKey),
    index("notifications_customer_id_idx").on(t.customerId),
    index("notifications_status_created_at_idx").on(t.status, t.createdAt),
    check(
      "notifications_recipient_check",
      sql`${t.customerId} IS NOT NULL OR ${t.email} IS NOT NULL`,
    ),
    check("notifications_channel_check", inList(t.channel, NOTIFICATION_CHANNELS)),
    check("notifications_status_check", inList(t.status, NOTIFICATION_STATUSES)),
    check("notifications_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: id(),
    customerId: uuid("customer_id").references(() => customers.id),
    email: text("email"),
    productFamily: text("product_family").notNull(),
    region: text("region").notNull(),
    reason: text("reason").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("waitlist_entries_customer_id_idx").on(t.customerId),
    check(
      "waitlist_entries_recipient_check",
      sql`${t.customerId} IS NOT NULL OR ${t.email} IS NOT NULL`,
    ),
    check("waitlist_entries_reason_check", inList(t.reason, WAITLIST_REASONS)),
  ],
);

export const supportRequests = pgTable(
  "support_requests",
  {
    id: id(),
    customerId: uuid("customer_id").references(() => customers.id),
    name: text("name"),
    email: text("email"),
    category: text("category").notNull(),
    relatedResourceId: uuid("related_resource_id").references(() => resources.id),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("open"),
    handledBy: uuid("handled_by").references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("support_requests_customer_id_idx").on(t.customerId),
    check(
      "support_requests_recipient_check",
      sql`${t.customerId} IS NOT NULL OR ${t.email} IS NOT NULL`,
    ),
    check("support_requests_status_check", inList(t.status, CASE_STATUSES)),
  ],
);

export const abuseCases = pgTable(
  "abuse_cases",
  {
    id: id(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    source: text("source").notNull(),
    status: text("status").notNull().default("open"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("abuse_cases_resource_id_idx").on(t.resourceId),
    check("abuse_cases_status_check", inList(t.status, CASE_STATUSES)),
  ],
);

export const discrepancies = pgTable(
  "discrepancies",
  {
    id: id(),
    kind: text("kind").notNull(),
    details: jsonb("details").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    check("discrepancies_kind_check", inList(t.kind, DISCREPANCY_KINDS)),
    check("discrepancies_status_check", inList(t.status, DISCREPANCY_STATUSES)),
  ],
);

// Append-only (A): the triggers are in 0005_triggers.sql, the grants in 0006_roles_and_grants.sql.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    // text: a target can be a domain name.
    targetId: text("target_id"),
    // NULL for a job.
    ip: inet("ip"),
    userAgent: text("user_agent"),
    // The reason of R10 goes here.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_actor_type_actor_id_created_at_idx").on(t.actorType, t.actorId, t.createdAt),
    index("audit_log_target_type_target_id_idx").on(t.targetType, t.targetId),
    check("audit_log_actor_type_check", inList(t.actorType, AUDIT_ACTOR_TYPES)),
    check("audit_log_actor_check", sql`(${t.actorType} = 'system') = (${t.actorId} IS NULL)`),
  ],
);
