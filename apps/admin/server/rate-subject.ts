import { createHmac } from "node:crypto";
import { Resource } from "sst/resource";

// WPU-X1: the key of the rate-limit subject of the admin app. No next/* import: the environment and the
// links are parameters. The HMAC key is the per-stage linked secret `AdminIpLimitKey` (R3). The address
// is only ever stored as the HMAC (R14).
//
// WPU-Z15: at run time the key is read through the SST SDK. SST 4.17.2 hands the Next.js server its
// links through the wrapper that decrypts the encrypted link file into globalThis.SST_KEY_FILE_DATA (no
// SST_RESOURCE_<Name> variable exists at run time), and the SDK's Resource reads that and every other
// delivery path (`sst dev` sets SST_RESOURCE_<Name>).

export type Env = Readonly<Record<string, string | undefined>>;

/** The properties of one linked SST resource; undefined when it is not linked or cannot be read. */
export type LinkSource = (name: string) => unknown;

const SECRET_NAME = "AdminIpLimitKey";
const MIN_KEY_LENGTH = 32;

// The links at run time. A name that is not linked, or links that cannot be loaded (a malformed
// variable, a file that does not decrypt), give undefined. The error is dropped unread: its text may
// quote the input (R3, R14).
export const sstLinks: LinkSource = (name) => {
  try {
    const links = Resource as unknown as Readonly<Record<string, unknown>>;
    return name in links ? links[name] : undefined;
  } catch {
    return undefined;
  }
};

// Tests: the same links as the variables SST_RESOURCE_<Name> of an environment object, each the JSON
// of one link (the form of `sst dev`).
export function envLinks(env: Env): LinkSource {
  return (name) => {
    const raw = env[`SST_RESOURCE_${name}`];
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
}

// Used ONLY when TC_STAGE is "local" or "test" and no secret is linked. Public on purpose: it protects
// nothing and must never be reachable in a deployed stage (resolveRateKey refuses there).
export const LOCAL_TEST_ONLY_RATE_KEY = "local-test-only-admin-ip-limit-key-not-a-secret";

function linkedSecret(links: LinkSource): string | null {
  const link = links(SECRET_NAME);
  if (typeof link !== "object" || link === null) return null;
  const value = (link as { value?: unknown }).value;
  return typeof value === "string" && value.length >= MIN_KEY_LENGTH ? value : null;
}

// Fail closed (R16): a deployed stage (anything but local or test, including an unset TC_STAGE) with no
// usable secret throws. The message is fixed and holds no value.
export function resolveRateKey(env: Env, links: LinkSource = sstLinks): string {
  const secret = linkedSecret(links);
  if (secret !== null) return secret;
  const stage = env["TC_STAGE"];
  if (stage === "local" || stage === "test") return LOCAL_TEST_ONLY_RATE_KEY;
  throw new Error("admin: rate-limit key is not available");
}

export const rateSubject = (key: string, value: string): string =>
  createHmac("sha256", key).update(value).digest("hex").slice(0, 32);
