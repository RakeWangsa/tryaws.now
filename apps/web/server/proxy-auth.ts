import { authConfigFromEnv } from "@tc/auth/proxy";
import type { AuthRuntimeLike } from "@tc/auth/proxy";
import { readWebConfig } from "./config.ts";

// The auth runtime of proxy.ts (open point 20), built from the environment alone: no database, no
// secrets. Production uses the Cognito refresh port and the real token verifier that `@tc/auth`
// builds by default. The fake refresh port and the dev verifier are loaded only when the fake
// identity switch is on (config.ts refuses it outside local and test). Built once per process.
// `null` = not configurable (pool variables missing): the proxy then refreshes nothing and the
// next verification decides what a request may do (R16).
//
// Adaptation to the plan: the plan has this function synchronous; the fakes arrive by a literal
// dynamic import(), so it returns a promise.

type Env = Readonly<Record<string, string | undefined>>;

const CACHE_KEY = "__tcProxyAuthRuntime";

async function build(env: Env): Promise<AuthRuntimeLike | null> {
  let config;
  let auth;
  try {
    config = readWebConfig(env);
    auth = authConfigFromEnv(env);
  } catch {
    return null;
  }
  if (!config.fake.idp) return { config: auth };
  const identity = await import("./fakes/identity.ts");
  const devAuth = await import("./fakes/dev-auth.ts");
  return { config: auth, verifier: devAuth.devVerifier, port: identity.createFakeRefreshPort() };
}

export function proxyAuthRuntime(env: Env): Promise<AuthRuntimeLike | null> {
  const holder = globalThis as unknown as Record<
    string,
    Promise<AuthRuntimeLike | null> | undefined
  >;
  const known = holder[CACHE_KEY];
  if (known !== undefined) return known;
  const started = build(env);
  holder[CACHE_KEY] = started;
  return started;
}
