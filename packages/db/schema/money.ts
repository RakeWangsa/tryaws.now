import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./admins";
import { createdAt, id, inList, money } from "./common";
import { customers } from "./identity";

// The nine ledger account types. STEP_ACCOUNTS of @tc/core holds four of them; packages/db stays
// independent of pricing, so the list is repeated here.
export const LEDGER_ACCOUNT_TYPES = [
  "customer_wallet",
  "gateway_clearing",
  "revenue_aws_base",
  "vat_korea_payable",
  "vat_bd_payable",
  "processing_fee_income",
  "markup_income",
  "refunds",
  "adjustments",
] as const;

export const wallets = pgTable(
  "wallets",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    currency: text("currency").notNull(),
    balanceMinor: money("balance_minor")
      .notNull()
      .default(sql`0`),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("wallets_customer_id_unique").on(t.customerId),
    check("wallets_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("wallets_balance_minor_check", sql`${t.balanceMinor} >= 0`),
  ],
);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: id(),
    type: text("type").notNull(),
    customerId: uuid("customer_id").references(() => customers.id),
    currency: text("currency").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ledger_accounts_customer_id_type_currency_unique")
      .on(t.customerId, t.type, t.currency)
      .nullsNotDistinct(),
    check("ledger_accounts_type_check", inList(t.type, LEDGER_ACCOUNT_TYPES)),
    check(
      "ledger_accounts_owner_check",
      sql`(${t.type} = 'customer_wallet') = (${t.customerId} IS NOT NULL)`,
    ),
    check("ledger_accounts_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

// Decided here: the three kinds of actor, the same list as audit_log.actor_type.
export const LEDGER_ACTOR_TYPES = ["customer", "admin", "system"] as const;

// Append-only (A); the triggers and the balance check are in 0005_triggers.sql.
export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: id(),
    // The values belong to LedgerKind of WP3-T1.
    kind: text("kind").notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actorType: text("actor_type").notNull(),
    // No foreign key: it points at a customer or an admin.
    actorId: uuid("actor_id"),
    memo: text("memo"),
    // WPU-Y2: the exact price inputs of the charge (ChargeSnapshot of @tc/core, schemaVersion 1), written
    // with the header. NULL on a row from before the column and on every kind that is not a sale.
    priceSnapshot: jsonb("price_snapshot"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ledger_transactions_idempotency_key_unique").on(t.idempotencyKey),
    index("ledger_transactions_reference_type_reference_id_idx").on(t.referenceType, t.referenceId),
    check("ledger_transactions_actor_type_check", inList(t.actorType, LEDGER_ACTOR_TYPES)),
    check(
      "ledger_transactions_price_snapshot_check",
      sql`${t.priceSnapshot} IS NULL OR (jsonb_typeof(${t.priceSnapshot}) = 'object' AND ${t.kind} IN ('purchase', 'renewal', 'metered_charge'))`,
    ),
    check(
      "ledger_transactions_actor_check",
      sql`(${t.actorType} = 'system') = (${t.actorId} IS NULL)`,
    ),
  ],
);

// Decided here: the two sides of a double-entry line (R5).
export const LEDGER_DIRECTIONS = ["debit", "credit"] as const;

// Append-only (A).
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    direction: text("direction").notNull(),
    amountMinor: money("amount_minor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_transaction_id_idx").on(t.transactionId),
    index("ledger_entries_account_id_idx").on(t.accountId),
    check("ledger_entries_direction_check", inList(t.direction, LEDGER_DIRECTIONS)),
    check("ledger_entries_amount_minor_check", sql`${t.amountMinor} > 0`),
  ],
);

// 9.1: "Admin credit or debit".
export const ADJUSTMENT_DIRECTIONS = ["credit", "debit"] as const;
export const ADJUSTMENT_KINDS = ["goodwill", "deposit", "correction"] as const;
export const ADJUSTMENT_STATUSES = ["pending", "approved", "rejected"] as const;

export const walletAdjustments = pgTable(
  "wallet_adjustments",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    direction: text("direction").notNull(),
    amountMinor: money("amount_minor").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    evidenceRef: text("evidence_ref"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => adminUsers.id),
    // NULL on an adjustment below the limit, which posts at once (9.1).
    approvedBy: uuid("approved_by").references(() => adminUsers.id),
    status: text("status").notNull().default("pending"),
    ledgerTransactionId: uuid("ledger_transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // Named by hand: the default name is longer than the 63 bytes PostgreSQL keeps.
    foreignKey({
      name: "wallet_adjustments_ledger_transaction_id_fk",
      columns: [t.ledgerTransactionId],
      foreignColumns: [ledgerTransactions.id],
    }),
    index("wallet_adjustments_customer_id_idx").on(t.customerId),
    unique("wallet_adjustments_ledger_transaction_id_unique").on(t.ledgerTransactionId),
    check("wallet_adjustments_direction_check", inList(t.direction, ADJUSTMENT_DIRECTIONS)),
    check("wallet_adjustments_amount_minor_check", sql`${t.amountMinor} > 0`),
    check("wallet_adjustments_kind_check", inList(t.kind, ADJUSTMENT_KINDS)),
    check("wallet_adjustments_reason_check", sql`length(btrim(${t.reason})) > 0`),
    check(
      "wallet_adjustments_approver_check",
      sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy}`,
    ),
    check("wallet_adjustments_status_check", inList(t.status, ADJUSTMENT_STATUSES)),
    check(
      "wallet_adjustments_posting_check",
      sql`(${t.status} = 'approved') = (${t.ledgerTransactionId} IS NOT NULL)`,
    ),
  ],
);

export const PAYMENT_STATUSES = [
  "initiated",
  "redirected",
  "credited",
  "failed",
  "cancelled",
  "expired",
  "review",
] as const;

export const payments = pgTable(
  "payments",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    gateway: text("gateway").notNull(),
    merchantTransactionId: text("merchant_transaction_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("initiated"),
    gatewayTransactionId: text("gateway_transaction_id"),
    verifyPayload: jsonb("verify_payload"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ledgerTransactionId: uuid("ledger_transaction_id").references(() => ledgerTransactions.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payments_merchant_transaction_id_unique").on(t.merchantTransactionId),
    unique("payments_customer_id_idempotency_key_unique").on(t.customerId, t.idempotencyKey),
    unique("payments_ledger_transaction_id_unique").on(t.ledgerTransactionId),
    // The sweeper.
    index("payments_status_created_at_idx").on(t.status, t.createdAt),
    // WPU-D3: one EPS transaction id belongs to one payment (migration 0021).
    uniqueIndex("payments_gateway_transaction_id_unique")
      .on(t.gatewayTransactionId)
      .where(sql`${t.gatewayTransactionId} is not null`),
    // 9.2.
    check("payments_merchant_transaction_id_check", sql`length(${t.merchantTransactionId}) >= 10`),
    check("payments_amount_minor_check", sql`${t.amountMinor} > 0`),
    check("payments_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("payments_status_check", inList(t.status, PAYMENT_STATUSES)),
    check(
      "payments_credit_check",
      sql`(${t.status} = 'credited') = (${t.ledgerTransactionId} IS NOT NULL)`,
    ),
  ],
);

export const ORDER_KINDS = ["new", "renew", "addon", "restore"] as const;
export const ORDER_STATUSES = ["paid", "fulfilled", "reversed"] as const;

export const orders = pgTable(
  "orders",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    kind: text("kind").notNull(),
    items: jsonb("items").notNull(),
    priceSnapshot: jsonb("price_snapshot").notNull(),
    totalMinor: money("total_minor").notNull(),
    // Every state of an order is paid.
    ledgerTransactionId: uuid("ledger_transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("paid"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("orders_ledger_transaction_id_unique").on(t.ledgerTransactionId),
    unique("orders_customer_id_idempotency_key_unique").on(t.customerId, t.idempotencyKey),
    check("orders_kind_check", inList(t.kind, ORDER_KINDS)),
    check("orders_total_minor_check", sql`${t.totalMinor} >= 0`),
    check("orders_status_check", inList(t.status, ORDER_STATUSES)),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    // First calendar year of the fiscal year: 2026 is July 2026 to June 2027.
    fiscalYear: smallint("fiscal_year").notNull(),
    // WP3-T5 allocates it under a transaction-level advisory lock.
    number: integer("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    // Nullable by ruling 9: an invoice that comes from no order has none.
    orderId: uuid("order_id").references(() => orders.id),
    lines: jsonb("lines").notNull(),
    totalMinor: money("total_minor").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    pdfKey: text("pdf_key"),
    // WPU-I2: the seller details of the day of issue, as the seller setting held them. A legal
    // document does not change on a reprint. NULL only on a row issued before this column existed;
    // such a row is never printed (the reader fails closed).
    seller: jsonb("seller"),
    // WPU-I2: the money transaction that this invoice is for (a purchase or a renewal). Unique: one
    // invoice for each charge (R7).
    ledgerTransactionId: uuid("ledger_transaction_id").references(() => ledgerTransactions.id),
    // WPU-I3: the buyer as the customer's billing profile read on the day of issue (name, address,
    // tax id), or null when the customer had entered none. Parsed by parseBuyerSnapshot of the core.
    buyer: jsonb("buyer"),
    createdAt: createdAt(),
    // WPU-C1: the instant of the charge (the ledger transaction time), the tax point of the supply. NULL on a
    // row issued before the column existed.
    supplyAt: timestamp("supply_at", { withTimezone: true }),
    // WPU-C1: 'invoice' (Mushak-6.3) or 'credit_note' (Mushak-6.7). Each kind numbers its own gap-free
    // sequence for each fiscal year.
    kind: text("kind").notNull().default("invoice"),
    // A credit note names the invoice it credits and the reversal it answers (both unique: one credit note
    // for each invoice and for each reversal, R7), and the reason.
    originalInvoiceId: uuid("original_invoice_id").references((): AnyPgColumn => invoices.id),
    creditForLedgerTransactionId: uuid("credit_for_ledger_transaction_id"),
    reason: text("reason"),
  },
  (t) => [
    // The generated name of this key is longer than the 63 bytes PostgreSQL keeps.
    foreignKey({
      name: "invoices_credit_for_ledger_tx_fk",
      columns: [t.creditForLedgerTransactionId],
      foreignColumns: [ledgerTransactions.id],
    }),
    unique("invoices_fiscal_year_kind_number_unique").on(t.fiscalYear, t.kind, t.number),
    unique("invoices_original_invoice_id_unique").on(t.originalInvoiceId),
    unique("invoices_credit_for_ledger_transaction_id_unique").on(t.creditForLedgerTransactionId),
    check("invoices_kind_check", sql`${t.kind} in ('invoice', 'credit_note')`),
    check(
      "invoices_credit_note_check",
      sql`(${t.kind} = 'credit_note') = (${t.originalInvoiceId} is not null and ${t.creditForLedgerTransactionId} is not null and ${t.reason} is not null) and (${t.kind} = 'credit_note' or (${t.originalInvoiceId} is null and ${t.creditForLedgerTransactionId} is null and ${t.reason} is null))`,
    ),
    check(
      "invoices_reason_check",
      sql`${t.reason} is null or ${t.reason} in ('refund', 'plan_change_not_delivered', 'order_failed')`,
    ),
    unique("invoices_order_id_unique").on(t.orderId),
    unique("invoices_ledger_transaction_id_unique").on(t.ledgerTransactionId),
    check(
      "invoices_seller_check",
      sql`${t.seller} IS NULL OR jsonb_typeof(${t.seller}) = 'object'`,
    ),
    index("invoices_customer_id_idx").on(t.customerId),
    check("invoices_fiscal_year_check", sql`${t.fiscalYear} >= 2026`),
    check("invoices_number_check", sql`${t.number} > 0`),
    check("invoices_lines_check", sql`jsonb_typeof(${t.lines}) = 'array'`),
    check("invoices_total_minor_check", sql`${t.totalMinor} >= 0`),
    check("invoices_buyer_check", sql`${t.buyer} is null or jsonb_typeof(${t.buyer}) = 'object'`),
  ],
);
