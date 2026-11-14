import {
  CUSTOMER_CLIENT_LINK,
  authConfigFromEnv,
  cognitoRefreshPort,
  customerClientFromLink,
} from "@tc/auth/proxy";
import type { AuthRuntimeLike } from "@tc/auth/proxy";
import { sstLinks, type LinkSource } from "@tc/db/links";
import { readWebConfig } from "./config.ts";
import { writeLog } from "./log.ts";

// The auth runtime of proxy.ts (open point 20), built from the environment and one link: no database.
// Production uses the real token verifier that `@tc/auth` builds by default and, since the customer app
// client has a secret (WPU-X12 round 4), a Cognito refresh port made from the SST link CustomerAppClient
// (the proxy runs in the web server function, which holds the link; VERIFY on staging). Without a
// readable link there is no port and the default refreshes nothing: the cookies stay and the next
// verification decides (R16). The fake refresh port and the dev verifier are loaded only when the fake
// identity switch is on (config.ts refuses it outside local and test). Built once per process, with one
// exception (re-review L1): a runtime built WITHOUT a port (the link could not be read) is kept for at most
// a minute and then built again, so one failed read does not end every session of the container at the
// 1-hour access token. Each such build logs the fixed line {"event":"auth.refresh","reason":"no_port"}.
// `null` = not configurable (pool variables missing): the proxy then refreshes nothing and the
// next verification decides what a request may do (R16).
//
// Adaptation to the plan: the plan has this function synchronous; the fakes arrive by a literal
// dynamic import(), so it returns a promise.

type Env = Readonly<Record<string, string | undefined>>;

const CACHE_KEY = "__tcProxyAuthRuntime";

async function build(env: Env, links: LinkSource): Promise<AuthRuntimeLike | null> {
  let config;
  let auth;
  try {
    config = readWebConfig(env);
    auth = authConfigFromEnv(env);
  } catch {
    return null;
  }
  // `process.env.NODE_ENV` is replaced by the bundler: in a production build the condition is the
  // constant false and no fake reaches the bundle (the smoke check "no fake EPS and no dev verifier").
  if (process.env.NODE_ENV !== "production" && config.fake.idp) {
    const identity = await import("./fakes/identity.ts");
    const devAuth = await import("./fakes/dev-auth.ts");
    return { config: auth, verifier: devAuth.devVerifier, port: identity.createFakeRefreshPort() };
  }
  try {
    const client = customerClientFromLink(links(CUSTOMER_CLIENT_LINK), auth.customer.clientId);
    return { config: auth, port: cognitoRefreshPort(auth.customer, client) };
  } catch {
    // the link is missing or malformed: no port (the error text holds no value and is dropped)
    writeLog({ event: "auth.refresh", reason: "no_port" });
    return { config: auth };
  }
}

/** A runtime built without a port is built again after this long. */
export const NO_PORT_RETRY_MS = 60_000;

interface Entry {
  readonly started: Promise<AuthRuntimeLike | null>;
  // Set once the build has finished without a port: when it may be built again.
  retryAt: number | undefined;
}

export function proxyAuthRuntime(
  env: Env,
  links: LinkSource = sstLinks,
  now: () => number = Date.now,
): Promise<AuthRuntimeLike | null> {
  const holder = globalThis as unknown as Record<string, Entry | undefined>;
  const known = holder[CACHE_KEY];
  if (known !== undefined && (known.retryAt === undefined || now() < known.retryAt)) {
    return known.started;
  }
  const entry: Entry = { started: build(env, links), retryAt: undefined };
  holder[CACHE_KEY] = entry;
  void entry.started.then(
    (runtime) => {
      if (runtime !== null && runtime.port === undefined) entry.retryAt = now() + NO_PORT_RETRY_MS;
    },
    () => {
      entry.retryAt = now() + NO_PORT_RETRY_MS;
    },
  );
  return entry.started;
}
