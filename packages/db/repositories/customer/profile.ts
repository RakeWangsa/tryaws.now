import { and, eq, isNull, sql } from "drizzle-orm";
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
  // WPU-X11: the account setup that replaced KYC as the buy condition. NULL = not done.
  emailVerifiedAt: Date | null;
  totpEnabledAt: Date | null;
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
// ids. The BIN is a business identifier: never logged (R14), read only through the
// session customer's scope.
export interface BillingProfile {
  billingName: string | null;
  billingAddress: string | null;
  customerBin: string | null;
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
  // WPU-I4: what the buyer snapshot of an invoice is made from, in one read: the billing profile and the
  // profile name (the name printed when no billing name was entered). Selected by name; worker_rw may
  // read these five columns only. Null when the customer does not exist.
  getBuyerSource(): Promise<{ name: string | null; billing: BillingProfile } | null>;
  // Absolute assignment of all four fields (null clears one): the same input gives the same state, so a
  // repeated submit is harmless (R7). Validated here as the CHECKs of the table are (defence in depth).
  setBilling(input: BillingProfile): Promise<Written<BillingProfile>>;
  // WPU-X11. Called by the sign-in after Cognito answered with tokens (it signs in confirmed addresses
  // only), never from a form. The first time is kept: a later call changes nothing (R7).
  markEmailVerified(at: Date): Promise<Written<CustomerProfile>>;
  // WPU-X11. Called by the authenticator actions only after Cognito accepted the code and saved the MFA
  // preference (a time), or switched it off (null); never from a form. Absolute assignment (R7).
  setTotpEnabled(at: Date | null): Promise<Written<CustomerProfile>>;
  // WPU-X11 round 2. Ends every session of the customer: authenticateCustomer refuses a token issued (or
  // whose sign-in happened) before this time. Called when the authenticator is switched on or off, with
  // Cognito's GlobalSignOut as the second half. The cut-off only ever moves forward.
  revokeSessions(at: Date): Promise<Written<true>>;
}

// The finer rule is the one of packages/core/validation; @tc/db cannot import @tc/core.
const BD_PHONE = /^\+880[0-9]{10}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

// The same rules as the CHECKs customers_billing_*_check, customers_customer_*_check and
// customers_tax_id_one_check, and as parseBillingProfile of the core (which @tc/db cannot import).
const CONTROL_OR_MARKUP = /[\p{Cc}<>]/u;
const BIN = /^[0-9]{13}$/;
const textOk = (value: unknown, min: number, max: number): boolean =>
  value === null ||
  (typeof value === "string" &&
    Array.from(value).length >= min &&
    Array.from(value).length <= max &&
    !CONTROL_OR_MARKUP.test(value));
function billingValid(input: BillingProfile): boolean {
  if (typeof input !== "object" || input === null) return false;
  const { billingName, billingAddress, customerBin } = input;
  if (!textOk(billingName, 2, 120) || !textOk(billingAddress, 5, 300)) return false;
  if (customerBin !== null && !(typeof customerBin === "string" && BIN.test(customerBin))) {
    return false;
  }
  return true;
}

// Only these three columns, named: the repository never reads or returns a column it did not list.
const BILLING_COLUMNS = {
  billingName: customers.billingName,
  billingAddress: customers.billingAddress,
  customerBin: customers.customerBin,
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
  emailVerifiedAt: customers.emailVerifiedAt,
  totpEnabledAt: customers.totpEnabledAt,
  createdAt: customers.createdAt,
};

// The parameter type makes the compiler check that the row holds all fourteen fields. The text columns
// hold only the values of their CHECKs, so narrowing them to the unions with the cast is exact.
const toProfile = (row: Record<keyof CustomerProfile, unknown>): CustomerProfile =>
  row as unknown as CustomerProfile;

const isTime = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

export function profileRepo(scope: TenantScope): ProfileRepo {
  return {
    markEmailVerified: async (at) => {
      if (!isTime(at)) return refused("validation");
      // Only a NULL is set; the row is read back either way, so a second call answers the first time.
      await scope.tx
        .update(customers)
        .set({ emailVerifiedAt: at })
        .where(and(eq(customers.id, scope.customerId), isNull(customers.emailVerifiedAt)));
      const [row] = await scope.tx
        .select(PROFILE_COLUMNS)
        .from(customers)
        .where(eq(customers.id, scope.customerId));
      return row === undefined ? refused("not_found") : created(toProfile(row));
    },

    revokeSessions: async (at) => {
      if (!isTime(at)) return refused("validation");
      // greatest(): a later cut-off is never lowered by an earlier one. Only this one column is named.
      const stamp = at.toISOString();
      const [row] = await scope.tx
        .update(customers)
        .set({
          sessionsValidAfter: sql`greatest(coalesce(${customers.sessionsValidAfter}, ${stamp}::timestamptz), ${stamp}::timestamptz)`,
        })
        .where(eq(customers.id, scope.customerId))
        .returning({ id: customers.id });
      return row === undefined ? refused("not_found") : created(true as const);
    },

    setTotpEnabled: async (at) => {
      if (at !== null && !isTime(at)) return refused("validation");
      const [row] = await scope.tx
        .update(customers)
        .set({ totpEnabledAt: at })
        .where(eq(customers.id, scope.customerId))
        .returning(PROFILE_COLUMNS);
      return row === undefined ? refused("not_found") : created(toProfile(row));
    },

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

    getBuyerSource: async () => {
      const [row] = await scope.tx
        .select({ name: customers.name, ...BILLING_COLUMNS })
        .from(customers)
        .where(eq(customers.id, scope.customerId));
      if (row === undefined) return null;
      const { name, ...billing } = row;
      return { name, billing };
    },

    setBilling: async (input) => {
      if (!billingValid(input)) return refused("validation");
      // The three values are named one by one: nothing else of the input reaches the statement.
      const [row] = await scope.tx
        .update(customers)
        .set({
          billingName: input.billingName,
          billingAddress: input.billingAddress,
          customerBin: input.customerBin,
        })
        .where(eq(customers.id, scope.customerId))
        .returning(BILLING_COLUMNS);
      return row === undefined ? refused("not_found") : created(row);
    },
  };
}
