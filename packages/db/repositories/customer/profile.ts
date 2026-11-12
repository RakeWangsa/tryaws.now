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

// WPU-I3: the billing profile of the customer, printed as the buyer of the Mushak 6.3 invoice. Kept
// apart from CustomerProfile: the profile screen and every other reader of `get` never carry the tax
// ids. BIN and NID are personal or business identifiers: never logged (R14), read only through the
// session customer's scope.
export interface BillingProfile {
  billingName: string | null;
  billingAddress: string | null;
  customerBin: string | null;
  customerNid: string | null;
}

export interface ProfileRepo {
  // `lock: "share"` keeps the row against a concurrent update (a KYC revocation, a suspension) until
  // the transaction ends: the purchase reads the customer this way so a decision that commits
  // between its check and its charge cannot be missed.
  get(options?: { lock?: "share" }): Promise<CustomerProfile | null>;
  update(input: ProfileUpdate): Promise<Written<CustomerProfile>>;
  // Called by the OTP service after a code was verified (WP2-T3), never from a form.
  setVerifiedPhone(input: { phone: string; verifiedAt: Date }): Promise<Written<CustomerProfile>>;
  // Called by the e-mail change action (WP2-T5) after the identity provider confirmed the code that
  // it sent to the new address, never from a form.
  setEmail(email: string): Promise<Written<CustomerProfile>>;
  // The billing profile (WPU-I3): read for the settings form and for the buyer snapshot at issue time.
  getBilling(): Promise<BillingProfile | null>;
  // Absolute assignment of all four fields (null clears one): the same input gives the same state, so a
  // repeated submit is harmless (R7). Validated here as the CHECKs of the table are (defence in depth).
  setBilling(input: BillingProfile): Promise<Written<BillingProfile>>;
}

// The finer rule is the one of packages/core/validation; @tc/db cannot import @tc/core.
const BD_PHONE = /^\+880[0-9]{10}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

// The same rules as the CHECKs customers_billing_*_check, customers_customer_*_check and
// customers_tax_id_one_check, and as parseBillingProfile of the core (which @tc/db cannot import).
const CONTROL_OR_MARKUP = /[\p{Cc}<>]/u;
const NID = /^([0-9]{10}|[0-9]{13}|[0-9]{17})$/;
const BIN = /^[0-9]{13}$/;
const textOk = (value: unknown, min: number, max: number): boolean =>
  value === null ||
  (typeof value === "string" &&
    Array.from(value).length >= min &&
    Array.from(value).length <= max &&
    !CONTROL_OR_MARKUP.test(value));
function billingValid(input: BillingProfile): boolean {
  if (typeof input !== "object" || input === null) return false;
  const { billingName, billingAddress, customerBin, customerNid } = input;
  if (!textOk(billingName, 2, 120) || !textOk(billingAddress, 5, 300)) return false;
  if (customerBin !== null && !(typeof customerBin === "string" && BIN.test(customerBin))) {
    return false;
  }
  if (customerNid !== null && !(typeof customerNid === "string" && NID.test(customerNid))) {
    return false;
  }
  return customerBin === null || customerNid === null;
}

// Only these four columns, named: the repository never reads or returns a column it did not list.
const BILLING_COLUMNS = {
  billingName: customers.billingName,
  billingAddress: customers.billingAddress,
  customerBin: customers.customerBin,
  customerNid: customers.customerNid,
};

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
    get: async (options) => {
      const query = scope.tx
        .select(PROFILE_COLUMNS)
        .from(customers)
        .where(eq(customers.id, scope.customerId));
      const [row] = await (options?.lock === "share" ? query.for("share") : query);
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

    // Absolute assignment, like update: the same input gives the same state. Drizzle names only the
    // two columns, which web_rw may update.
    setVerifiedPhone: async (input) => {
      if (!BD_PHONE.test(input.phone)) return refused("validation");
      const [row] = await scope.tx
        .update(customers)
        .set({ phone: input.phone, phoneVerifiedAt: input.verifiedAt })
        .where(eq(customers.id, scope.customerId))
        .returning(PROFILE_COLUMNS);
      return row === undefined ? refused("not_found") : created(toProfile(row));
    },

    // Absolute assignment, like the others. Drizzle names only the one column, which web_rw may update.
    setEmail: async (email) => {
      if (typeof email !== "string" || email !== email.toLowerCase() || !EMAIL.test(email)) {
        return refused("validation");
      }
      const [row] = await scope.tx
        .update(customers)
        .set({ email })
        .where(eq(customers.id, scope.customerId))
        .returning(PROFILE_COLUMNS);
      return row === undefined ? refused("not_found") : created(toProfile(row));
    },

    getBilling: async () => {
      const [row] = await scope.tx
        .select(BILLING_COLUMNS)
        .from(customers)
        .where(eq(customers.id, scope.customerId));
      return row === undefined ? null : row;
    },

    setBilling: async (input) => {
      if (!billingValid(input)) return refused("validation");
      // The four values are named one by one: nothing else of the input reaches the statement.
      const [row] = await scope.tx
        .update(customers)
        .set({
          billingName: input.billingName,
          billingAddress: input.billingAddress,
          customerBin: input.customerBin,
          customerNid: input.customerNid,
        })
        .where(eq(customers.id, scope.customerId))
        .returning(BILLING_COLUMNS);
      return row === undefined ? refused("not_found") : created(row);
    },
  };
}
