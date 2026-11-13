import { Resource } from "sst/resource";

// The secrets of the web app (EPS, the keys, the SMS gateway) reach it only through this port (R3).
// WPU-Z15: at run time they are read through the SST SDK. SST 4.17.2 hands the Next.js server its links
// through the wrapper that decrypts the encrypted link file into globalThis.SST_KEY_FILE_DATA (the
// SST_RESOURCE_<Name> variables exist for `next build` only), and the SDK's Resource reads that and
// every other delivery path (`sst dev` sets SST_RESOURCE_<Name>). A secret is read when asked for and
// is never held in a module constant; an unreadable one is `undefined`, and the caller fails closed
// (R16). WPU-Z3: SmsApiKey (the Gennet api_token) and SmsSenderId (the sid), for the phone OTP.

export type SecretName =
  | "EpsMerchantId"
  | "EpsStoreId"
  | "EpsUsername"
  | "EpsPassword"
  | "EpsHashKey"
  | "EpsLimitKey"
  | "OrderDraftSecret"
  | "AuthLimitKey"
  | "OtpHashKey"
  | "SmsApiKey"
  | "SmsSenderId";

export type SecretSource = (name: SecretName) => string | undefined;

/** The properties of one linked SST resource; undefined when it is not linked or cannot be read. */
export type LinkSource = (name: string) => unknown;

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
export function envLinks(env: Readonly<Record<string, string | undefined>>): LinkSource {
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

// The `value` of a linked sst.Secret, when it is a string that is not empty.
export function linkedSecrets(links: LinkSource = sstLinks): SecretSource {
  return (name) => {
    const link = links(name);
    if (typeof link !== "object" || link === null) return undefined;
    const value = (link as { value?: unknown }).value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
}
