import { requireFreshSignIn } from "@tc/auth";
import { parseBillingProfile } from "@tc/core";
import type { CustomerLimit } from "@tc/db";
import { formObject, formText, readForm } from "./form-schema.ts";
import type {
  SettingsDeps,
  SettingsFailure,
  SettingsRepos,
  SettingsResult,
} from "./settings-actions.ts";

// The Server Action core of the "Billing details" section of /settings/profile (WPU-I3): the name,
// the address and the BIN or NID that the Mushak 6.3 invoice prints for the buyer. R9 order: authenticate,
// authorize (the action acts on the row of the session's customer only, R8; a change to the BIN or the
// NID, setting, changing or clearing, needs a fresh sign-in of the last 10 minutes, 6.1 and U10, WPU-S8;
// the name and the address do not), validate with zod, rate limit, execute, audit. The stored NID is never
// sent to the browser, so an empty NID field keeps it and `clearCustomerNid` removes it.
//
// The BIN and the NID are personal or business identifiers (R14): they are never logged, never put in
// an audit entry (the entry names the fields that are set, never a value) and never put in an error.
// Idempotent by absolute assignment (R7, like updateProfileCore): the same form leaves the same state.

const BILLING_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "settings.billing", limit: 20, windowSeconds: 3600 }),
]);

// The shape layer: the four fields the form names, trimmed text; any other key is dropped (R11).
const BillingForm = formObject({
  billingName: formText,
  billingAddress: formText,
  customerBin: formText,
  customerNid: formText,
  clearCustomerNid: formText,
});

const fail = (
  error: SettingsFailure["error"],
  fields?: Record<string, string>,
): SettingsFailure => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

async function audit(repos: SettingsRepos, fields: readonly string[]): Promise<void> {
  const written = await repos.audit.record({
    action: "profile.billing_updated",
    targetType: "customer",
    metadata: { fields },
  });
  if (!written.ok) throw new Error("settings: the audit entry was refused");
}

export async function updateBillingCore(deps: SettingsDeps, raw: unknown): Promise<SettingsResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");

  const form = readForm(BillingForm, raw);
  const parsed = parseBillingProfile(form);
  if (!parsed.ok) return fail("validation", parsed.fields);
  const typed = parsed.value;
  const clearNid = form.clearCustomerNid === "on" || form.clearCustomerNid === "true";

  try {
    return await deps.store(session.customerId, async (repos): Promise<SettingsResult> => {
      const stored = await repos.profile.getBilling();
      // An empty NID field keeps the stored NID (it is not sent to the browser); only an explicit
      // request clears it. The BIN is shown in full, so the form sends it back and it is assigned as is.
      const keepNid = typed.customerNid === null && !clearNid;
      const billing = {
        ...typed,
        customerNid: keepNid ? (stored?.customerNid ?? null) : typed.customerNid,
      };
      if (billing.customerBin !== null && billing.customerNid !== null) {
        return fail("validation", { customerBin: "conflict", customerNid: "conflict" });
      }
      // Authorize: a change to either tax identifier needs a fresh sign-in (R9, R16). Nothing is spent or
      // written before this answer.
      const changed =
        billing.customerBin !== (stored?.customerBin ?? null) ||
        billing.customerNid !== (stored?.customerNid ?? null);
      if (changed && !requireFreshSignIn(session, { now: deps.now }).ok) {
        return fail("fresh_sign_in_required");
      }
      const limit = await repos.rateLimits.consume(BILLING_LIMITS, deps.now());
      if (!limit.allowed) return fail("rate_limited");
      const saved = await repos.profile.setBilling(billing);
      if (!saved.ok) return fail("unavailable");
      // Which fields are set now, as names: never their values.
      const set = (Object.keys(billing) as (keyof typeof billing)[]).filter(
        (k) => billing[k] !== null,
      );
      await audit(repos, set);
      return { ok: true };
    });
  } catch {
    // Nothing of the error is kept: it could hold a value of the form.
    return fail("unavailable");
  }
}
