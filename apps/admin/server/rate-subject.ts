import { createHmac } from "node:crypto";

// WPU-X1: the key of the rate-limit subject of the admin app. Pure: the environment is a parameter,
// no next/* import. The HMAC key is the per-stage linked secret `AdminIpLimitKey` (R3), read from the
// SST_RESOURCE_AdminIpLimitKey variable like the web app does (apps/web/server/secrets.ts). The address
// is only ever stored as the HMAC (R14).

export type Env = Readonly<Record<string, string | undefined>>;

const SECRET_VARIABLE = "SST_RESOURCE_AdminIpLimitKey";
const MIN_KEY_LENGTH = 32;

// Used ONLY when TC_STAGE is "local" or "test" and no secret is linked. Public on purpose: it protects
// nothing and must never be reachable in a deployed stage (resolveRateKey refuses there).
export const LOCAL_TEST_ONLY_RATE_KEY = "local-test-only-admin-ip-limit-key-not-a-secret";

function linkedSecret(env: Env): string | null {
  const raw = env[SECRET_VARIABLE];
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { value?: unknown }).value;
    return typeof value === "string" && value.length >= MIN_KEY_LENGTH ? value : null;
  } catch {
    return null;
  }
}

// Fail closed (R16): a deployed stage (anything but local or test, including an unset TC_STAGE) with no
// usable secret throws. The message is fixed and holds no value.
export function resolveRateKey(env: Env): string {
  const secret = linkedSecret(env);
  if (secret !== null) return secret;
  const stage = env["TC_STAGE"];
  if (stage === "local" || stage === "test") return LOCAL_TEST_ONLY_RATE_KEY;
  throw new Error("admin: rate-limit key is not available");
}

export const rateSubject = (key: string, value: string): string =>
  createHmac("sha256", key).update(value).digest("hex").slice(0, 32);
