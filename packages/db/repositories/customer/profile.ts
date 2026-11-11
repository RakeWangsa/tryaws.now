import { eq } from "drizzle-orm";
import type {
  CUSTOMER_STATUSES,
  CUSTOMER_TYPES,
  KYC_STATUSES,
  LOCALES,
  RISK_TIERS,
} from "../../schema/identity";
import { customers } from "../../schema/index";
import { created, refused, type Written } from "../result";
import type { TenantScope } from "../scope";

// The customer's own row, without cognito_sub and sessions_valid_after (internal to the login).
// The unions are built from the lists that the CHECKs customers_*_check are built from.
export interface CustomerProfile {
  id: string;
  email: string;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  name: string | null;
  type: (typeof CUSTOMER_TYPES)[number] | null;
  kycStatus: (typeof KYC_STATUSES)[number];
  riskTier: (typeof RISK_TIERS)[number];
  market: string;
  locale: (typeof LOCALES)[number];
  status: (typeof CUSTOMER_STATUSES)[number];
  createdAt: Date;
}

// The two things a customer changes here. Phone and email change through their own verified flows
// (WP2-T3, WP2-T5); kyc_status, risk_tier, market and status are set by staff or by the system.
export interface ProfileUpdate {
  name?: string | null;
  locale?: (typeof LOCALES)[number];
}

export interface ProfileRepo {
  get(): Promise<CustomerProfile | null>;
  update(input: ProfileUpdate): Promise<Written<CustomerProfile>>;
}

// Selected and returned by name: the repository never reads or returns a column it did not list.
const PROFILE_COLUMNS = {
  id: customers.id,
  email: customers.email,
  phone: customers.phone,
  phoneVerifiedAt: customers.phoneVerifiedAt,
  name: customers.name,
  type: customers.type,
  kycStatus: customers.kycStatus,
  riskTier: customers.riskTier,
  market: customers.market,
  locale: customers.locale,
  status: customers.status,
  createdAt: customers.createdAt,
};

// The parameter type makes the compiler check that the row holds all twelve fields. The text columns
// hold only the values of their CHECKs, so narrowing them to the unions with the cast is exact.
const toProfile = (row: Record<keyof CustomerProfile, unknown>): CustomerProfile =>
  row as unknown as CustomerProfile;

export function profileRepo(scope: TenantScope): ProfileRepo {
  return {
    get: async () => {
      const [row] = await scope.tx
        .select(PROFILE_COLUMNS)
        .from(customers)
        .where(eq(customers.id, scope.customerId));
      return row === undefined ? null : toProfile(row);
    },

    // Idempotent by absolute assignment: the same input leaves the same state. R7's unique key does
    // not apply, because no table has a column for it (open point 19).
    update: async (input) => {
      // Only name and locale are ever read from the input (open point 13). The grants of web_rw also
      // allow email, phone and sessions_valid_after, so an input that carries more (a cast, or a form
      // that was not validated) must not reach them. A key whose value is undefined is no change, as
      // an empty form field gives.
      const set = Object.fromEntries(
        Object.entries({ name: input.name, locale: input.locale }).filter(
          ([, value]) => value !== undefined,
        ),
      );
      // Drizzle would throw a plain Error("No values to set"); the answer is a refusal, with no query.
      if (Object.keys(set).length === 0) return refused("validation");
      const [row] = await scope.tx
        .update(customers)
        .set(set)
        .where(eq(customers.id, scope.customerId))
        .returning(PROFILE_COLUMNS);
      return row === undefined ? refused("not_found") : created(toProfile(row));
    },
  };
}
