import { authConfigFromEnv, cognitoIdentityProvider, configureAuth } from "@tc/auth";
import type { AccessTokenVerifier, IdentityProvider } from "@tc/auth";
import { newUuidV7, withTx } from "@tc/db";
import {
  EPS_RETURN_PATHS,
  createEps,
  createEpsGateway,
  epsCredentials,
  epsReturnUrls,
} from "@tc/eps";
import type { Eps, EpsDeps, EpsGateway } from "@tc/eps";
import { OTP_SEND_RULES } from "@tc/notify";
import type { OtpDeps, SmsProvider } from "@tc/notify";
import { headers } from "next/headers";
import { readWebConfig } from "./config.ts";
import type { WebConfig } from "./config.ts";
import type { ReaderPort } from "./extras-view.ts";
import type { KycPorts } from "./kyc-actions.ts";
import { writeLog } from "./log.ts";
import { readerPortFromEnv } from "./reader-invoke.ts";
import { resourceSecrets } from "./secrets.ts";
import type { AccountPorts } from "./settings-actions.ts";

// The one composition of apps/web (open point 1): configuration from the environment, secrets
// through a port, the EPS services built once. The fakes are reached only through the two literal
// dynamic imports below, and only when the configuration says fakes (which config.ts refuses in
// staging and production, R16).

export interface WebRuntime {
  config: WebConfig;
  /** null = not configured: the screens show the "not open" state (R16). */
  eps: Eps | null;
  /** The identity provider behind the auth screens. null = not configured: "not available" (R16). */
  identity: IdentityProvider | null;
  /** The phone OTP service parts. null when the hashing key or an SMS provider is missing. */
  otp: (OtpDeps & { sms: SmsProvider; limits: typeof OTP_SEND_RULES }) | null;
  /** The key of the auth rate-limit subjects. null: every public auth action refuses (R16). */
  authLimitKey: string | null;
  /**
   * The object store and the crypto of the identity check (WP2-T4). null = not configured, which is
   * every stage but local and test until the S3 and KMS adapters are verified on staging: /kyc then
   * shows the "not open" state (R16).
   */
  kyc: KycPorts | null;
  /**
   * The identity provider's change calls and the phone OTP service of /settings (WP2-T5). null =
   * not configured: the changes of e-mail, phone and password refuse (R16). Only local and test
   * have it until the Cognito and SMS adapters are verified on staging.
   */
  account: AccountPorts | null;
  /**
   * The invoke port of the `reader` function for the Metrics tab (WPU-G4). null = not configured: the
   * tab says "not available" (R16). Local and test with fakes use a dev reader instead.
   */
  reader: ReaderPort | null;
}

type Env = Readonly<Record<string, string | undefined>>;

interface Assembled {
  runtime: WebRuntime;
  /** Holds the limit key: never part of `runtime`, never exported past the tests. */
  deps: EpsDeps | null;
  verifier?: AccessTokenVerifier;
}

const MIN_KEY_LENGTH = 32;
const usableKey = (value: string | undefined): string | null =>
  typeof value === "string" && value.length >= MIN_KEY_LENGTH ? value : null;

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
          event: event.kind,
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
  const secret = resourceSecrets(env);

  let eps: Eps | null = null;
  let deps: EpsDeps | null = null;
  let verifier: AccessTokenVerifier | undefined;

  if (process.env.NODE_ENV !== "production" && config.fake.eps) {
    // Literal specifiers, so the boundary can be checked (tests/repo/web-fakes.test.mjs).
    const bridge = await import("./fakes/eps-bridge.ts");
    const dev = bridge.getDevEps();
    // epsReturnUrls wants https; in fake mode the origin is http://localhost:<port>.
    const urls = {
      successUrl: config.appOrigin + EPS_RETURN_PATHS.success,
      failUrl: config.appOrigin + EPS_RETURN_PATHS.fail,
      cancelUrl: config.appOrigin + EPS_RETURN_PATHS.cancel,
    };
    deps = buildDeps(dev.gateway, hex(randomBytes(32)), urls);
    eps = createEps(deps);
  } else {
    const merchantId = secret("EpsMerchantId");
    const storeId = secret("EpsStoreId");
    const username = secret("EpsUsername");
    const password = secret("EpsPassword");
    const hashKey = secret("EpsHashKey");
    const limitKey = secret("EpsLimitKey");
    if (
      merchantId !== undefined &&
      storeId !== undefined &&
      username !== undefined &&
      password !== undefined &&
      hashKey !== undefined &&
      limitKey !== undefined
    ) {
      const gateway = createEpsGateway(
        epsCredentials({ mode: config.epsMode, merchantId, storeId, username, password, hashKey }),
        {
          fetch: globalThis.fetch.bind(globalThis),
          clock: { now: () => new Date() },
          timeoutMs: EPS_CALL_TIMEOUT_MS,
        },
      );
      deps = buildDeps(gateway, limitKey, epsReturnUrls(config.appOrigin));
      eps = createEps(deps);
    }
  }

  // The dev sign-in token `dev.<sub>` is accepted only when a fake that issues it is on.
  if (process.env.NODE_ENV !== "production" && (config.fake.eps || config.fake.idp)) {
    const auth = await import("./fakes/dev-auth.ts");
    verifier = auth.devVerifier;
  }

  // Keys for the limiter and the OTP hash: from the secret port; in fake mode a random one for the
  // life of the process when none is given. Shorter than 32 characters is the same as missing (R16).
  let authLimitKey = usableKey(secret("AuthLimitKey"));
  let otpKey = usableKey(secret("OtpHashKey"));
  if (config.fakes) {
    authLimitKey ??= hex(randomBytes(32));
    otpKey ??= hex(randomBytes(32));
  }

  let identity: IdentityProvider | null;
  if (process.env.NODE_ENV !== "production" && config.fake.idp) {
    const fake = await import("./fakes/identity.ts");
    identity = fake.createFakeIdentity({ stage: config.stage, fakes: config.fakes });
  } else {
    try {
      identity = cognitoIdentityProvider(authConfigFromEnv(env).customer);
    } catch {
      identity = null; // pool variables missing or malformed: the screens show "not available"
    }
  }

  let sms: SmsProvider | null = null;
  if (process.env.NODE_ENV !== "production" && config.fake.sms) {
    const outbox = await import("./fakes/outbox.ts");
    sms = outbox.getFakeSms();
  }
  const otp =
    sms !== null && otpKey !== null
      ? {
          run: withTx,
          clock: { now: () => new Date() },
          pepper: otpKey,
          sms,
          limits: OTP_SEND_RULES,
        }
      : null;

  // The KYC store and the account changes have no real adapter before the staging VERIFY: only the
  // fakes, only in development and test (the literal condition lets the bundler drop the imports).
  let kyc: KycPorts | null = null;
  let account: AccountPorts | null = null;
  if (process.env.NODE_ENV !== "production" && config.fakes) {
    const kycFakes = await import("./fakes/kyc-fakes.ts");
    const accountFakes = await import("./fakes/account-fakes.ts");
    kyc = kycFakes.getDevKyc();
    account = accountFakes.getDevAccount();
  }

  // The reader of the Metrics tab: the Lambda invoke port when READER_FUNCTION_NAME is set; a dev
  // reader only in development and test with fakes (the literal condition lets the bundler drop it).
  let reader: ReaderPort | null = readerPortFromEnv(env);
  if (process.env.NODE_ENV !== "production" && config.fakes) {
    const readerFake = await import("./fakes/reader-fake.ts");
    reader = readerFake.devReader();
  }

  return {
    runtime: { config, eps, identity, otp, authLimitKey, kyc, account, reader },
    deps,
    ...(verifier !== undefined ? { verifier } : {}),
  };
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
