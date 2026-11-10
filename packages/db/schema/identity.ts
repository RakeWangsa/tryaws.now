import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./admins";
import { markets } from "./catalog";
import { bytea, createdAt, id } from "./common";

export const customers = pgTable(
  "customers",
  {
    id: id(),
    cognitoSub: text("cognito_sub").notNull(),
    // NULL means no cut-off yet: a token issued just before the row exists must pass.
    sessionsValidAfter: timestamp("sessions_valid_after", { withTimezone: true }),
    // Not unique: Cognito owns uniqueness.
    email: text("email").notNull(),
    phone: text("phone"),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    name: text("name"),
    type: text("type"),
    kycStatus: text("kyc_status").notNull().default("none"),
    riskTier: text("risk_tier").notNull().default("new"),
    market: text("market")
      .notNull()
      .references(() => markets.code),
    locale: text("locale").notNull().default("bn"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("customers_cognito_sub_unique").on(t.cognitoSub),
    check("customers_type_check", sql`${t.type} in ('individual', 'business')`),
    check(
      "customers_kyc_status_check",
      sql`${t.kycStatus} in ('none', 'pending', 'verified', 'rejected')`,
    ),
    check("customers_risk_tier_check", sql`${t.riskTier} in ('new', 'trusted')`),
    // Decided here: the two locales of market BD; another market replaces this CHECK later.
    check("customers_locale_check", sql`${t.locale} in ('bn', 'en')`),
    check("customers_status_check", sql`${t.status} in ('active', 'suspended')`),
  ],
);

export const kycSubmissions = pgTable(
  "kyc_submissions",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    documentType: text("document_type").notNull(),
    // The KMS envelope (encrypted data key and ciphertext); WP2 owns the format.
    documentNumberEncrypted: bytea("document_number_encrypted").notNull(),
    s3Keys: text("s3_keys").array().notNull(),
    status: text("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id").references(() => adminUsers.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("kyc_submissions_customer_id_idx").on(t.customerId),
    check("kyc_submissions_s3_keys_check", sql`cardinality(${t.s3Keys}) >= 1`),
    // Decided here: the values of customers.kyc_status without 'none'.
    check("kyc_submissions_status_check", sql`${t.status} in ('pending', 'verified', 'rejected')`),
    check(
      "kyc_submissions_review_check",
      sql`${t.status} = 'pending' OR (${t.reviewerId} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
  ],
);

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    name: text("name").notNull(),
    // Public keys only.
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("ssh_keys_customer_id_fingerprint_unique").on(t.customerId, t.fingerprint)],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    // Also a new number waiting for changePhone.
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // The limit of 5 is code and config.
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("otp_challenges_customer_id_created_at_idx").on(t.customerId, t.createdAt),
    check("otp_challenges_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: id(),
    scopeKey: text("scope_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("rate_limits_scope_key_window_start_unique").on(t.scopeKey, t.windowStart),
    // For the purge of old windows.
    index("rate_limits_window_start_idx").on(t.windowStart),
    check("rate_limits_count_check", sql`${t.count} >= 0`),
  ],
);

// (A) append-only. No unique key on (customer_id, document, version): 12 saves a domain
// registration consent with every order.
export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    document: text("document").notNull(),
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    ip: inet("ip").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("legal_acceptances_customer_id_document_idx").on(t.customerId, t.document),
    check(
      "legal_acceptances_document_check",
      sql`${t.document} in ('terms', 'acceptable_use', 'privacy', 'refund', 'domain_registration')`,
    ),
  ],
);
