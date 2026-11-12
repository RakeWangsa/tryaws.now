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
// the address and the optional BIN that the Mushak 6.3 invoice prints for the buyer. R9 order: authenticate,
// authorize (the action acts on the row of the session's customer only, R8; a change to the BIN, setting,
// changing or clearing, needs a fresh sign-in of the last 10 minutes, 6.1 and U10, WPU-S8; the name and
// the address do not), validate with zod, rate limit, execute, audit. There is no NID (WPU-D3).
//
// The BIN is a business identifier (R14): it is never logged, never put in an audit entry (the entry names
// the fields that are set, never a value) and never put in an error. Idempotent by absolute assignment
// (R7, like updateProfileCore): the same form leaves the same state.

const BILLING_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "settings.billing", limit: 20, windowSeconds: 3600 }),
]);

// The shape layer: the three fields the form names, trimmed text; any other key is dropped (R11).
const BillingForm = formObject({
  billingName: formText,
  billingAddress: formText,
  customerBin: formText,
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

  try {
    return await deps.store(session.customerId, async (repos): Promise<SettingsResult> => {
      const stored = await repos.profile.getBilling();
      const billing = typed;
      // Authorize: a change to the BIN needs a fresh sign-in (R9, R16). Nothing is spent or written
      // before this answer.
      const changed = billing.customerBin !== (stored?.customerBin ?? null);
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
