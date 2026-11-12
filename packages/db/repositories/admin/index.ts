import type { Tx } from "../../client";
import type { ADMIN_ROLES } from "../../schema/admins";
import { isUuid } from "../scope";
import { adminUsersAdminRepo, type AdminUsersAdminRepo } from "./admin-users";
import { blueprintsAdminRepo, type BlueprintsAdminRepo } from "./blueprints";
import { auditAdminRepo, type AuditAdminRepo } from "./audit";
import { configPricesAdminRepo, type ConfigPricesAdminRepo } from "./config-prices";
import { customersAdminRepo, type CustomersAdminRepo } from "./customers";
import { tierLimitsAdminRepo, type TierLimitsAdminRepo } from "./tier-limits";
import { capacityAdminRepo, type CapacityAdminRepo } from "./capacity";
import { featureFlagsAdminRepo, type FeatureFlagsAdminRepo } from "./feature-flags";
import { fxChangesAdminRepo, type FxChangesAdminRepo } from "./fx-changes";
import { fxRatesAdminRepo, type FxRatesAdminRepo } from "./fx-rates";
import { operationsAdminRepo, type OperationsAdminRepo } from "./operations";
import { paymentsAdminRepo, type PaymentsAdminRepo } from "./payments";
import { priceBookAdminRepo, type PriceBookAdminRepo } from "./price-book";
import { pricingRulesAdminRepo, type PricingRulesAdminRepo } from "./pricing-rules";
import { abuseAdminRepo, type AbuseAdminRepo } from "./abuse";
import { reconciliationAdminRepo, type ReconciliationAdminRepo } from "./reconciliation";
import { supportAdminRepo, type SupportAdminRepo } from "./support";
import { waitlistAdminRepo, type WaitlistAdminRepo } from "./waitlist";
import { walletsAdminRepo, type WalletsAdminRepo } from "./wallets";

export type AdminRole = (typeof ADMIN_ROLES)[number];

// The admin who acts, as the admin app's requireAdmin returns it (session, TOTP and IP allowlist were
// checked there). ip and userAgent go into the audit row of every write (R10).
export interface AdminActor {
  readonly adminId: string;
  readonly role: AdminRole;
  readonly ip: string;
  readonly userAgent?: string;
}

// The scope of one admin request: the transaction and the actor. Admin repositories are built from
// this and from nothing else.
export interface AdminScope {
  readonly tx: Tx;
  readonly actor: AdminActor;
}

// WP8 tasks add a repository as repositories/admin/<name>.ts exporting <name>AdminRepo(scope).
export interface AdminRepos {
  adminUsers: AdminUsersAdminRepo;
  audit: AuditAdminRepo;
  blueprints: BlueprintsAdminRepo;
  capacity: CapacityAdminRepo;
  configPrices: ConfigPricesAdminRepo;
  customers: CustomersAdminRepo;
  tierLimits: TierLimitsAdminRepo;
  featureFlags: FeatureFlagsAdminRepo;
  fxChanges: FxChangesAdminRepo;
  fxRates: FxRatesAdminRepo;
  operations: OperationsAdminRepo;
  payments: PaymentsAdminRepo;
  priceBook: PriceBookAdminRepo;
  pricingRules: PricingRulesAdminRepo;
  abuse: AbuseAdminRepo;
  reconciliation: ReconciliationAdminRepo;
  support: SupportAdminRepo;
  waitlist: WaitlistAdminRepo;
  wallets: WalletsAdminRepo;
}

// Binds the actor once and builds every admin repository from it. Throws a TypeError for an actor
// without a UUID admin id or without an IP (R16), before any query. It does not check roles:
// requireAdmin(roles) does that before (R9). The message is fixed text (R14).
export function adminRepos(tx: Tx, actor: AdminActor): AdminRepos {
  if (
    typeof actor?.adminId !== "string" ||
    !isUuid(actor.adminId) ||
    typeof actor.ip !== "string" ||
    actor.ip === ""
  ) {
    throw new TypeError("adminRepos: the admin actor is incomplete");
  }
  const scope: AdminScope = Object.freeze({ tx, actor: Object.freeze({ ...actor }) });
  return {
    adminUsers: adminUsersAdminRepo(scope),
    audit: auditAdminRepo(scope),
    blueprints: blueprintsAdminRepo(scope),
    capacity: capacityAdminRepo(scope),
    configPrices: configPricesAdminRepo(scope),
    customers: customersAdminRepo(scope),
    tierLimits: tierLimitsAdminRepo(scope),
    featureFlags: featureFlagsAdminRepo(scope),
    fxChanges: fxChangesAdminRepo(scope),
    fxRates: fxRatesAdminRepo(scope),
    operations: operationsAdminRepo(scope),
    payments: paymentsAdminRepo(scope),
    priceBook: priceBookAdminRepo(scope),
    pricingRules: pricingRulesAdminRepo(scope),
    abuse: abuseAdminRepo(scope),
    reconciliation: reconciliationAdminRepo(scope),
    support: supportAdminRepo(scope),
    waitlist: waitlistAdminRepo(scope),
    wallets: walletsAdminRepo(scope),
  };
}
