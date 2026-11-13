// WPU-Z3: the two secrets of the SMS gateway reach the notifier only through this reader (R3): SmsApiKey
// (the Gennet api_token) and SmsSenderId (the sid). SST gives each linked secret as the variable
// SST_RESOURCE_<Name>, a JSON object with `value` (the convention of apps/web/server/secrets.ts and
// packages/db/env.ts; VERIFY on the first deploy, docs/runbooks/sms-gateway.md). A secret is read when
// asked for and is never held in a module constant; an unreadable or empty one is `undefined`, and the
// caller then keeps SMS off (R16). No value is logged or thrown (R3, R14).

export type NotifierSecretName = "SmsApiKey" | "SmsSenderId";

export function linkedSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: NotifierSecretName,
): string | undefined {
  const raw = env[`SST_RESOURCE_${name}`];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as { value?: unknown }).value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
