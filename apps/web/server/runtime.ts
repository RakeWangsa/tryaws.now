import { authConfigFromEnv, configureAuth } from "@tc/auth";
import type { AccessTokenVerifier } from "@tc/auth";
import { newUuidV7, withTx } from "@tc/db";
import {
  EPS_RETURN_PATHS,
  createEps,
  createEpsGateway,
  epsCredentials,
  epsReturnUrls,
} from "@tc/eps";
import type { Eps, EpsDeps, EpsGateway } from "@tc/eps";
import { headers } from "next/headers";
import { readWebConfig } from "./config.ts";
import type { WebConfig } from "./config.ts";
import type { KycPorts } from "./kyc-actions.ts";
import { writeLog } from "./log.ts";
import { resourceSecrets } from "./secrets.ts";

// The one composition of apps/web (open point 1): configuration from the environment, secrets
// through a port, the EPS services built once. The fakes are reached only through the two literal
// dynamic imports below, and only when the configuration says fakes (which config.ts refuses in
// staging and production, R16).

export interface WebRuntime {
  config: WebConfig;
  /** null = not configured: the screens show the "not open" state (R16). */
  eps: Eps | null;
  /**
   * The object store and the crypto of the identity check (WP2-T4). null = not configured, which is
   * every stage but local and test until the S3 and KMS adapters are verified on staging: /kyc then
   * shows the "not open" state (R16).
   */
  kyc: KycPorts | null;
}

type Env = Readonly<Record<string, string | undefined>>;

interface Assembled {
  runtime: WebRuntime;
  /** Holds the limit key: never part of `runtime`, never exported past the tests. */
  deps: EpsDeps | null;
  verifier?: AccessTokenVerifier;
}

const EPS_CALL_TIMEOUT_MS = 8000;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

function buildDeps(gateway: EpsGateway, limitKey: string, urls: EpsDeps["urls"]): EpsDeps {
  return {
    gateway,
    clock: { now: () => new Date() },
    run: withTx,
    newPaymentId: newUuidV7,
    randomBytes,
    limitKey,
    urls,
    // Finance is told through the log until WP5-T5 sends the e-mail (open point 10). Amounts are
    // decimal text, never Number (R4); no name, phone, e-mail or URL (R14).
    alert: {
      async raise(event) {
        writeLog({
          event: "payment_review",
          severity: "alert",
          paymentId: event.paymentId,
          reason: event.reason,
          expectedMinor: event.expectedMinor.toString(),
          gotMinor: event.gotMinor === null ? null : event.gotMinor.toString(),
        });
      },
    },
    log: (event, fields) => writeLog({ event, ...fields }),
  };
}

/** Pure of the process: the environment is the parameter. Exported for the tests. */
export async function assembleRuntime(env: Env): Promise<Assembled> {
  const config = readWebConfig(env);

  if (config.fakes) {
    // Literal specifiers, so the boundary can be checked (tests/repo/web-fakes.test.mjs).
    const bridge = await import("./fakes/eps-bridge.ts");
    const auth = await import("./fakes/dev-auth.ts");
    const kyc = await import("./fakes/kyc-fakes.ts");
    const dev = bridge.getDevEps();
    // epsReturnUrls wants https; in fake mode the origin is http://localhost:<port>.
    const urls = {
      successUrl: config.appOrigin + EPS_RETURN_PATHS.success,
      failUrl: config.appOrigin + EPS_RETURN_PATHS.fail,
      cancelUrl: config.appOrigin + EPS_RETURN_PATHS.cancel,
    };
    const deps = buildDeps(dev.gateway, hex(randomBytes(32)), urls);
    return {
      runtime: { config, eps: createEps(deps), kyc: kyc.getDevKyc() },
      deps,
      verifier: auth.devVerifier,
    };
  }

  const secret = resourceSecrets(env);
  const merchantId = secret("EpsMerchantId");
  const storeId = secret("EpsStoreId");
  const username = secret("EpsUsername");
  const password = secret("EpsPassword");
  const hashKey = secret("EpsHashKey");
  const limitKey = secret("EpsLimitKey");
  if (
    merchantId === undefined ||
    storeId === undefined ||
    username === undefined ||
    password === undefined ||
    hashKey === undefined ||
    limitKey === undefined
  ) {
    return { runtime: { config, eps: null, kyc: null }, deps: null };
  }

  const gateway = createEpsGateway(
    epsCredentials({ mode: config.epsMode, merchantId, storeId, username, password, hashKey }),
    {
      fetch: globalThis.fetch.bind(globalThis),
      clock: { now: () => new Date() },
      timeoutMs: EPS_CALL_TIMEOUT_MS,
    },
  );
  const deps = buildDeps(gateway, limitKey, epsReturnUrls(config.appOrigin));
  return { runtime: { config, eps: createEps(deps), kyc: null }, deps };
}

const CACHE_KEY = "__tcWebRuntime";

/** Built on the first call and cached on globalThis; a failed build keeps nothing, the next call tries again. */
export function getRuntime(): Promise<WebRuntime> {
  const holder = globalThis as unknown as Record<string, Promise<WebRuntime> | undefined>;
  const cached = holder[CACHE_KEY];
  if (cached !== undefined) return cached;
  const started = build();
  holder[CACHE_KEY] = started;
  started.catch(() => {
    if (holder[CACHE_KEY] === started) delete holder[CACHE_KEY];
  });
  return started;
}

async function build(): Promise<WebRuntime> {
  const env = process.env;
  const { runtime, verifier } = await assembleRuntime(env);
  configureAuth({
    config: authConfigFromEnv(env),
    readCookieHeader: async () => (await headers()).get("cookie"),
    ...(verifier !== undefined ? { deps: { verifier } } : {}),
  });
  return runtime;
}
