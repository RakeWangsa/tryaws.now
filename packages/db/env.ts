import { Resource } from "sst/resource";

// A local development value, not a secret (the password belongs to docker-compose.yml).
export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud";

// The only message of every failure below: no host, no name, no secret name and no value (R3, R14).
export const DATABASE_URL_ERROR = "database: the connection is not configured";

type Env = Readonly<Record<string, string | undefined>>;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9_]{1,63}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** The properties of one linked SST resource; undefined when it is not linked or cannot be read. */
export type LinkSource = (name: string) => unknown;

// WPU-Z15: the links at run time. SST 4.17.2 hands a deployed function its links in an encrypted file
// (SST_KEY_FILE, SST_KEY), which the server wrapper of sst.aws.Nextjs decrypts into
// globalThis.SST_KEY_FILE_DATA; only `sst dev` sets the variables SST_RESOURCE_<Name>. The SDK's
// Resource reads every one of these paths. A name that is not linked, or links that cannot be loaded
// (a malformed variable, a file that does not decrypt), give undefined and the caller fails closed
// (R16). The error is dropped unread: its text may quote the input (R3, R14).
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

// The `value` of a linked sst.Secret, when it is a string that is not empty.
function secretValue(link: unknown): string | undefined {
  if (typeof link !== "object" || link === null) return undefined;
  const value = (link as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// The URL of the database at run time (R2, R3). `DATABASE_URL` (local and test) wins. Otherwise the
// parts come from the environment of the deploy (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_SSLMODE: none
// of them a secret) and the password from the linked secret that DB_PASSWORD_SECRET names (read through
// `links`, the SST SDK at run time), so a password is never in a deploy-time variable. TLS only:
// `require` or `verify-full` (default), nothing weaker. Anything missing or malformed fails closed with
// DATABASE_URL_ERROR (R16).
export function databaseUrlFromEnv(env: Env, links: LinkSource = sstLinks): string {
  const direct = env.DATABASE_URL;
  if (direct !== undefined && direct !== "") return direct;

  const { DB_HOST: host, DB_PORT: port, DB_NAME: name, DB_USER: user } = env;
  const secretName = env.DB_PASSWORD_SECRET;
  const sslmode = env.DB_SSLMODE ?? "verify-full";
  if (
    host === undefined ||
    !HOST.test(host) ||
    port === undefined ||
    !/^[0-9]{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    name === undefined ||
    !NAME.test(name) ||
    user === undefined ||
    !NAME.test(user) ||
    secretName === undefined ||
    !SECRET_NAME.test(secretName) ||
    (sslmode !== "require" && sslmode !== "verify-full")
  ) {
    throw new Error(DATABASE_URL_ERROR);
  }
  const password = secretValue(links(secretName));
  if (password === undefined) throw new Error(DATABASE_URL_ERROR);
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=${sslmode}`;
}

// A deployed stage (the TC_STAGE of infra/lib/stage.ts) never falls back to the local URL.
const DEPLOYED_STAGES = ["staging", "production"];

export function databaseUrl(env: Env = process.env, links: LinkSource = sstLinks): string {
  const direct = env.DATABASE_URL;
  if (direct !== undefined && direct !== "") return direct;
  if (env.DB_HOST !== undefined || DEPLOYED_STAGES.includes(env.TC_STAGE ?? "")) {
    return databaseUrlFromEnv(env, links);
  }
  return LOCAL_DATABASE_URL;
}
