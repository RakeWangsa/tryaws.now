import type { Clock, Logger } from "@tc/core";
import type { Tx } from "@tc/db";
import {
  createEps,
  createEpsGateway,
  epsCredentials,
  epsReturnUrls,
  type Eps,
  type EpsDeps,
  type EpsGateway,
} from "@tc/eps";
import { createLogAlert } from "./alert";
import type { SweeperConfig } from "./config";
import { createSkippedHandler, createSweeperHandler, type SweeperReport } from "./handler";
import { epsConfigured, type SecretSource } from "./secrets";

export interface SweeperEnv {
  readonly config: SweeperConfig;
  readonly secrets: SecretSource;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly log: Logger;
  readonly randomBytes: (n: number) => Uint8Array;
  /** Tests only: replaces the HTTP gateway (the secrets are then read but never sent anywhere). */
  readonly gateway?: EpsGateway;
}

const EPS_CALL_TIMEOUT_MS = 8000;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Assembles the EPS services from values handed in: no environment access, no global clock, no global fetch.
 * The sweeper never starts a payment and has no client address, so the rate-limit key is random per
 * build (not a secret link) and newPaymentId throws (open point 7).
 */
export function buildSweeperDeps(env: SweeperEnv): {
  eps: Eps;
  epsDeps: EpsDeps;
  handler: ReturnType<typeof createSweeperHandler>;
} {
  const { config, secrets } = env;
  const credentials = epsCredentials({
    mode: config.mode,
    merchantId: secrets.get("EpsMerchantId"),
    storeId: secrets.get("EpsStoreId"),
    username: secrets.get("EpsUsername"),
    password: secrets.get("EpsPassword"),
    hashKey: secrets.get("EpsHashKey"),
  });
  const gateway =
    env.gateway ??
    createEpsGateway(credentials, {
      fetch: env.fetch,
      clock: env.clock,
      timeoutMs: EPS_CALL_TIMEOUT_MS,
    });
  const epsDeps: EpsDeps = {
    gateway,
    clock: env.clock,
    run: env.runTx,
    newPaymentId: () => {
      throw new Error("sweeper: cannot create a payment");
    },
    randomBytes: env.randomBytes,
    limitKey: hex(env.randomBytes(32)),
    urls: epsReturnUrls(config.baseUrl),
    alert: createLogAlert(env.log),
    log: (event, fields) => env.log({ event, ...fields }),
  };
  const eps = createEps(epsDeps);
  const handler = createSweeperHandler({
    sweep: (o) => eps.sweep(o),
    log: env.log,
    limit: config.limit,
  });
  return { eps, epsDeps, handler };
}

/**
 * The handler of the job (index.ts). WPU-Z11: while an EPS secret holds the placeholder (EPS not
 * configured), no gateway is built and the job asks EPS nothing; otherwise it is the sweeper above.
 */
export function buildSweeper(env: SweeperEnv): (event?: unknown) => Promise<SweeperReport> {
  if (!epsConfigured(env.secrets)) {
    return createSkippedHandler({ log: env.log, limit: env.config.limit });
  }
  return buildSweeperDeps(env).handler;
}
