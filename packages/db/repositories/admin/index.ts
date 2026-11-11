import type { Tx } from "../../client";
import type { ADMIN_ROLES } from "../../schema/admins";
import { isUuid } from "../scope";
import { customersAdminRepo, type CustomersAdminRepo } from "./customers";
import { capacityAdminRepo, type CapacityAdminRepo } from "./capacity";
import { featureFlagsAdminRepo, type FeatureFlagsAdminRepo } from "./feature-flags";
import { fxRatesAdminRepo, type FxRatesAdminRepo } from "./fx-rates";
import { operationsAdminRepo, type OperationsAdminRepo } from "./operations";
import { paymentsAdminRepo, type PaymentsAdminRepo } from "./payments";
import { pricingRulesAdminRepo, type PricingRulesAdminRepo } from "./pricing-rules";
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
  capacity: CapacityAdminRepo;
  customers: CustomersAdminRepo;
  featureFlags: FeatureFlagsAdminRepo;
  fxRates: FxRatesAdminRepo;
  operations: OperationsAdminRepo;
  payments: PaymentsAdminRepo;
  pricingRules: PricingRulesAdminRepo;
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
    capacity: capacityAdminRepo(scope),
    customers: customersAdminRepo(scope),
    featureFlags: featureFlagsAdminRepo(scope),
    fxRates: fxRatesAdminRepo(scope),
    operations: operationsAdminRepo(scope),
    payments: paymentsAdminRepo(scope),
    pricingRules: pricingRulesAdminRepo(scope),
    waitlist: waitlistAdminRepo(scope),
    wallets: walletsAdminRepo(scope),
  };
}
