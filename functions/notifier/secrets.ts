import { Resource } from "sst/resource";

// WPU-Z3: the two secrets of the SMS gateway reach the notifier only through this reader (R3): SmsApiKey
// (the Gennet api_token) and SmsSenderId (the sid). A secret is read when asked for and is never held in
// a module constant; an unreadable or empty one is `undefined`, and the caller then keeps SMS off (R16).
// No value is logged or thrown (R3, R14).
//
// WPU-Z15: at run time the secrets are read through the SST SDK. SST 4.17.2 hands a deployed function
// its links only in an encrypted file (SST_KEY_FILE, SST_KEY), which the SDK's Resource decrypts; only
// `sst dev` sets the variables SST_RESOURCE_<Name>.

export type NotifierSecretName = "SmsApiKey" | "SmsSenderId";

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

// The `value` of the linked sst.Secret, when it is a string that is not empty.
export function linkedSecret(links: LinkSource, name: NotifierSecretName): string | undefined {
  const link = links(name);
  if (typeof link !== "object" || link === null) return undefined;
  const value = (link as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
