// A local development value, not a secret (the password belongs to docker-compose.yml).
export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud";

// The only message of every failure below: no host, no name, no secret name and no value (R3, R14).
export const DATABASE_URL_ERROR = "database: the connection is not configured";

type Env = Readonly<Record<string, string | undefined>>;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9_]{1,63}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// The password of a linked secret: SST v3 gives each link as the variable SST_RESOURCE_<Name>, a JSON
// object with `value` (the convention of apps/web/server/secrets.ts).
function linkedSecret(env: Env, name: string): string | undefined {
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

// The URL of the database at run time (R2, R3). `DATABASE_URL` (local and test) wins. Otherwise the
// parts come from the environment of the deploy (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_SSLMODE: none
// of them a secret) and the password from the linked secret that DB_PASSWORD_SECRET names, so a
// password is never in a deploy-time variable. TLS only: `require` or `verify-full` (default), nothing
// weaker. Anything missing or malformed fails closed with DATABASE_URL_ERROR (R16).
export function databaseUrlFromEnv(env: Env): string {
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
  const password = linkedSecret(env, secretName);
  if (password === undefined) throw new Error(DATABASE_URL_ERROR);
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=${sslmode}`;
}

// A deployed stage (the TC_STAGE of infra/lib/stage.ts) never falls back to the local URL.
const DEPLOYED_STAGES = ["staging", "production"];

export function databaseUrl(env: Env = process.env): string {
  const direct = env.DATABASE_URL;
  if (direct !== undefined && direct !== "") return direct;
  if (env.DB_HOST !== undefined || DEPLOYED_STAGES.includes(env.TC_STAGE ?? "")) {
    return databaseUrlFromEnv(env);
  }
  return LOCAL_DATABASE_URL;
}
