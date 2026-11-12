import { formObject, formText, readForm } from "./form-schema.ts";
import { addSshKeyCore, type KeyActionDeps } from "./key-actions.ts";
import {
  createOrderDraftCore,
  type DraftActionResult,
  type OrderActionDeps,
} from "./order-actions.ts";
import { parseSshKeyInput } from "./ssh-key.ts";

// WPU-G10. The key step of the create wizard, like the Lightsail console: choose a key you have, make a new
// pair in the browser, or paste a public key. The last two store the PUBLIC key with addSshKeyCore, the
// core of /settings/ssh-keys (tenant-scoped repository, rate limit, audit, idempotent by fingerprint), and
// the draft then continues with the id of that key. A private key is not a field of this form; one pasted
// into the public field is refused by parseSshKeyInput and never echoed (R14).
// R9 across the two steps: authenticate, validate (zod for the shape, the domain rule for the key), then
// each core rate limits, executes and audits for itself. A key that was stored is kept if the draft is
// refused afterwards (a plan too small, say): the same public key on the next try is a replay.

const MODES = ["existing", "generate", "paste"] as const;
type Mode = (typeof MODES)[number];

const WizardKey = formObject({
  keyMode: formText,
  newKeyName: formText,
  newKeyPublic: formText,
});

const isMode = (value: unknown): value is Mode =>
  typeof value === "string" && (MODES as readonly string[]).includes(value);

export async function createServerDraftCore(
  orderDeps: OrderActionDeps,
  keyDeps: KeyActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  // 1. Authenticate. Nothing else runs without a session (R16).
  const session = await keyDeps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  // 2. Validate. A form from before the key step has no mode and is the existing-key form.
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const choice = readForm(WizardKey, raw);
  const mode = choice.keyMode === undefined || choice.keyMode === "" ? "existing" : choice.keyMode;
  if (!isMode(mode)) {
    return { ok: false, error: "validation", fields: { keyMode: "invalid" } };
  }
  if (mode === "existing") return createOrderDraftCore(orderDeps, input);

  const parsed = parseSshKeyInput({ name: choice.newKeyName, publicKey: choice.newKeyPublic });
  if (!parsed.ok) {
    const fields: Record<string, string> = {};
    if (parsed.fields?.["name"] !== undefined) fields["newKeyName"] = "invalid";
    if (parsed.fields?.["publicKey"] !== undefined) fields["newKeyPublic"] = "invalid";
    return { ok: false, error: "validation", fields };
  }

  // 3. Store the public key (the core rate limits, adds and audits).
  const stored = await addSshKeyCore(keyDeps, {
    name: parsed.value.name,
    publicKey: parsed.value.publicKey,
  });
  if (!stored.ok) {
    if (stored.error === "conflict") {
      return { ok: false, error: "validation", fields: { newKeyName: "taken" } };
    }
    if (stored.error === "rate_limited") return { ok: false, error: "rate_limited" };
    if (stored.error === "validation") {
      return { ok: false, error: "validation", fields: { newKeyPublic: "invalid" } };
    }
    if (stored.error === "unauthenticated") return { ok: false, error: "unauthenticated" };
    return { ok: false, error: "unavailable" };
  }

  // 4. The draft, with the id of the key just stored. The id the form carried is not trusted.
  return createOrderDraftCore(orderDeps, { ...input, keyPairId: stored.id });
}
