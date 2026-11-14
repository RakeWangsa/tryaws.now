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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./admins";
import { markets } from "./catalog";
import { bytea, createdAt, id, inList } from "./common";

export const CUSTOMER_TYPES = ["individual", "business"] as const;
export const KYC_STATUSES = ["none", "pending", "verified", "rejected"] as const;
export const RISK_TIERS = ["new", "trusted"] as const;
// Decided here: the two locales of market BD; another market replaces this CHECK later.
export const LOCALES = ["bn", "en"] as const;
export const CUSTOMER_STATUSES = ["active", "suspended"] as const;

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
    // WPU-I3: the billing profile the customer enters in settings, printed as the buyer of the Mushak
    // 6.3 invoice. All nullable. personal or business identifiers: never logged (R14).
    billingName: text("billing_name"),
    billingAddress: text("billing_address"),
    // 13-digit BIN of a registered business (WPU-D3: no NID, migration 0019 dropped customer_nid).
    customerBin: text("customer_bin"),
    // WPU-X11 (owner decision 2026-11-14): the account setup that replaced KYC as the buy condition.
    // Set by the server only: at the first sign-in (Cognito signs in confirmed addresses only), and after
    // Cognito accepted the authenticator code (VerifySoftwareToken, SetUserMFAPreference). NULL = not done.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("customers_cognito_sub_unique").on(t.cognitoSub),
    check(
      "customers_billing_name_check",
      sql`${t.billingName} is null or (char_length(${t.billingName}) between 2 and 120 and ${t.billingName} !~ '[[:cntrl:]<>]')`,
    ),
    check(
      "customers_billing_address_check",
      sql`${t.billingAddress} is null or (char_length(${t.billingAddress}) between 5 and 300 and ${t.billingAddress} !~ '[[:cntrl:]<>]')`,
    ),
    check(
      "customers_customer_bin_check",
      sql`${t.customerBin} is null or ${t.customerBin} ~ '^[0-9]{13}$'`,
    ),
    check("customers_type_check", inList(t.type, CUSTOMER_TYPES)),
    check("customers_kyc_status_check", inList(t.kycStatus, KYC_STATUSES)),
    check("customers_risk_tier_check", inList(t.riskTier, RISK_TIERS)),
    check("customers_locale_check", inList(t.locale, LOCALES)),
    check("customers_status_check", inList(t.status, CUSTOMER_STATUSES)),
  ],
);

// Decided here: the values of customers.kyc_status without 'none'.
export const KYC_SUBMISSION_STATUSES = ["pending", "verified", "rejected"] as const;

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
    // WPU-D3: one open submission per customer, enforced by the database (migration 0020).
    uniqueIndex("kyc_submissions_one_pending_idx")
      .on(t.customerId)
      .where(sql`${t.status} = 'pending'`),
    check("kyc_submissions_s3_keys_check", sql`cardinality(${t.s3Keys}) >= 1`),
    check("kyc_submissions_status_check", inList(t.status, KYC_SUBMISSION_STATUSES)),
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

export const LEGAL_DOCUMENTS = [
  "terms",
  "acceptable_use",
  "privacy",
  "refund",
  "domain_registration",
] as const;

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
    check("legal_acceptances_document_check", inList(t.document, LEGAL_DOCUMENTS)),
  ],
);
