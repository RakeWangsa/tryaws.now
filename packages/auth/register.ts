import { isNewCustomerValid, readMarket, registerCustomer } from "@tc/db";
import type { NewCustomer, Tx } from "@tc/db";
import type { IdentityProvider } from "./identity";

export interface RegisterDeps {
  readonly idp: IdentityProvider;
  // withTx in production. One call is one transaction.
  readonly run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export type AccountRegistered =
  | { readonly ok: true; readonly status: "created" | "exists" }
  | {
      readonly ok: false;
      readonly error:
        "validation" | "market_unavailable" | "rate_limited" | "upstream_unavailable" | "internal";
    };

// Sign-up, in the order that fails closed (R16, open point 11):
//   1. the input is checked, and the market is read and must be active, before the identity provider
//      is called: a bad input or a closed market creates no user there;
//   2. the identity provider creates the user; an address that exists looks like a new one
//      (status "exists", no table is touched, the caller answers as for "created");
//   3. only a created user gets its customers row, with wallet, account, acceptances and audit row,
//      in one transaction under the sub the provider returned.
// A failure of step 3 after step 2 leaves a user without a row, the orphan case: the answer is
// "internal", the caller logs signup.orphan_risk, and a later sign-in finds no row and is refused
// (unknown_subject). The password goes to the identity provider and nowhere else. Never throws.
export async function registerAccount(
  deps: RegisterDeps,
  input: Omit<NewCustomer, "cognitoSub"> & { readonly password: string },
): Promise<AccountRegistered> {
  try {
    const { password, ...customer } = input;
    if (typeof password !== "string" || !isNewCustomerValid({ ...customer, cognitoSub: "x" })) {
      return { ok: false, error: "validation" };
    }

    const market = await deps.run((tx) => readMarket(tx, customer.market));
    if (market === null || !market.active) return { ok: false, error: "market_unavailable" };

    const signUp = await deps.idp.signUp({
      email: customer.email,
      password,
      name: customer.name,
      locale: customer.locale,
    });
    if (!signUp.ok) {
      switch (signUp.kind) {
        case "invalid_password":
          return { ok: false, error: "validation" };
        case "rate_limited":
          return { ok: false, error: "rate_limited" };
        default:
          return { ok: false, error: "upstream_unavailable" };
      }
    }
    if (signUp.value.kind === "exists") return { ok: true, status: "exists" };

    const sub = signUp.value.sub;
    try {
      // Named fields only: nothing of the input but what the row needs, never the password.
      const registered = await deps.run((tx) =>
        registerCustomer(tx, {
          cognitoSub: sub,
          email: customer.email,
          phone: customer.phone,
          name: customer.name,
          market: customer.market,
          locale: customer.locale,
          acceptances: customer.acceptances,
          ip: customer.ip,
          ...(customer.userAgent === undefined ? {} : { userAgent: customer.userAgent }),
        }),
      );
      return registered.ok ? { ok: true, status: "created" } : { ok: false, error: "internal" };
    } catch {
      return { ok: false, error: "internal" };
    }
  } catch {
    // The market read failed, or the identity provider broke its own promise not to throw.
    return { ok: false, error: "upstream_unavailable" };
  }
}
