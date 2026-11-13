import { Resource } from "sst/resource";

// WPU-Z15: the one reader of linked SST values of the repository (@tc/db/links). packages/db/env.ts,
// apps/web/server/secrets.ts, apps/admin/server/rate-subject.ts, functions/migrator/config.ts and
// functions/notifier/secrets.ts read through it, so the guard below exists once. It loads only the
// resource entry of the SST SDK: no database driver, so a reader that needs no database loads none.
//
// SST 4.17.2 hands a deployed function its links in an encrypted file (SST_KEY_FILE, SST_KEY), which
// the server wrapper of sst.aws.Nextjs decrypts into globalThis.SST_KEY_FILE_DATA; only `sst dev` sets
// the variables SST_RESOURCE_<Name>. The SDK's Resource reads every one of these paths.

/** The properties of one linked SST resource; undefined when it is not linked or cannot be read. */
export type LinkSource = (name: string) => unknown;

// The links at run time. A name that is not linked, or links that cannot be loaded (a malformed
// variable, a file that does not decrypt), give undefined and the caller fails closed (R16). The
// error is dropped unread: its text may quote the input (R3, R14).
export const sstLinks: LinkSource = (name) => {
  try {
    const links = Resource as unknown as Readonly<Record<string, unknown>>;
    return name in links ? links[name] : undefined;
  } catch {
    return undefined;
  }
};

// Tests: the same links as the variables SST_RESOURCE_<Name> of an environment object, each the JSON
// of one link (the form of `sst dev`). The object is read at the time of use.
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

// The `value` of a linked sst.Secret, when it is a string that is not empty; undefined for every other
// shape.
export function secretValue(link: unknown): string | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  const value = (link as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// The value a person stores for a secret that is deliberately not configured yet (WPU-Z11 EPS values,
// WPU-Z18 FirstAdminSub, the optional SMS secrets). SST needs a value for every declared secret, so
// scripts/golive/stage-secrets.sh and infra/stacks/secrets.ts use this literal (tests/repo pins they equal
// it). It reads as no value: the caller fails closed exactly as for a missing secret (R16).
export const NOT_CONFIGURED = "not-configured";

// secretValue, with the placeholder NOT_CONFIGURED read as no value (only the whole value, never a prefix).
export function configuredSecretValue(link: unknown): string | undefined {
  const value = secretValue(link);
  return value === NOT_CONFIGURED ? undefined : value;
}
