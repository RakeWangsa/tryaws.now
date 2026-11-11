import { eq } from "drizzle-orm";
import type { Tx } from "../client";
import type { CUSTOMER_STATUSES, KYC_STATUSES, LOCALES, RISK_TIERS } from "../schema/identity";
import { customers } from "../schema/index";

// The one read of customers that has no customer id yet: it is the step that creates the scope.
// Only packages/auth calls it (tests/repo/auth-boundaries.test.mjs). Not part of customerRepos.
export interface CustomerIdentity {
  readonly id: string;
  readonly status: (typeof CUSTOMER_STATUSES)[number];
  readonly sessionsValidAfter: Date | null;
  readonly kycStatus: (typeof KYC_STATUSES)[number];
  readonly riskTier: (typeof RISK_TIERS)[number];
  readonly locale: (typeof LOCALES)[number];
}

// The longest sub that the lookup sends to the database.
const MAX_SUB_LENGTH = 128;

// Selected by name: exactly six columns, no email, no phone, no name (R14, least data).
const IDENTITY_COLUMNS = {
  id: customers.id,
  status: customers.status,
  sessionsValidAfter: customers.sessionsValidAfter,
  kycStatus: customers.kycStatus,
  riskTier: customers.riskTier,
  locale: customers.locale,
};

// A sub that is not a non-empty string of at most 128 characters returns null without a query (R16).
// The match is exact (cognito_sub is unique); the sub is a bound parameter, so case, whitespace and
// LIKE wildcards are plain characters. A suspended customer is returned as it is: the caller decides.
export async function lookupCustomerBySub(tx: Tx, sub: string): Promise<CustomerIdentity | null> {
  if (typeof sub !== "string" || sub.length === 0 || sub.length > MAX_SUB_LENGTH) return null;
  const [row] = await tx
    .select(IDENTITY_COLUMNS)
    .from(customers)
    .where(eq(customers.cognitoSub, sub))
    .limit(1);
  // The text columns hold only the values of their CHECKs, so the row has the unions of the interface.
  return row === undefined ? null : (row as CustomerIdentity);
}
