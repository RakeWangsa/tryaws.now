import {
  CUSTOMER_CLIENT_LINK,
  SIGN_UP_CLIENT_LINK,
  authConfigFromEnv,
  cognitoIdentityProvider,
  cognitoTotpPort,
  configureAuth,
  customerClientFromLink,
  signUpClientFromLink,
} from "@tc/auth";
import { sstLinks, type LinkSource } from "@tc/db/links";
import type { AccessTokenVerifier, IdentityProvider, TotpPort } from "@tc/auth";
import { newUuidV7, withTx } from "@tc/db";
import {
  EPS_RETURN_PATHS,
  createEps,
  createEpsGateway,
  epsCredentials,
  epsReturnUrls,
} from "@tc/eps";
import type { Eps, EpsDeps, EpsGateway } from "@tc/eps";
import { GatewaySmsProvider, GennetSmsTransport, OTP_SEND_RULES } from "@tc/notify";
import type { OtpDeps, SmsProvider } from "@tc/notify";
import type { KycUploadCheck } from "@tc/core";
import { headers } from "next/headers";
import { readWebConfig } from "./config.ts";
import type { WebConfig } from "./config.ts";
import type { ReaderPort } from "./extras-view.ts";
import type { KycPorts } from "./kyc-actions.ts";
import { writeLog } from "./log.ts";
import { accessPortFromEnv, type AccessPort } from "./access-invoke.ts";
import { kycCheckPortFromEnv } from "./kyc-check-invoke.ts";
import { readerPortFromEnv } from "./reader-invoke.ts";
import { rendererPortFromEnv, type RendererPort } from "./renderer-invoke.ts";
import { linkedSecrets, type SecretSource } from "./secrets.ts";
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
   * shows the "not open" state (R16). The arrival check is its own port (`kycCheck`).
   */
  kyc: Omit<KycPorts, "check"> | null;
  /**
   * The invoke port of the `kyc-check` function (WPU-Y3): did a KYC upload arrive, its size and type.
   * null = not configured: a KYC submit refuses as unavailable (R16). Local and test with fakes use the
   * in-memory stand-in instead.
   */
  kycCheck: KycUploadCheck | null;
  /**
   * The identity provider's change calls and the phone OTP service of /settings (WP2-T5). null =
   * not configured: the changes of e-mail, phone and password refuse (R16). Only local and test
   * have it until the Cognito and SMS adapters are verified on staging.
   */
  account: AccountPorts | null;
  /**
   * WPU-X11: the customer's authenticator in the customer pool (AssociateSoftwareToken,
   * VerifySoftwareToken, SetUserMFAPreference with the customer's own access token). null = the pool
   * is not configured: the authenticator actions refuse (R16). Local and test with the fake identity
   * use the in-memory authenticator.
   */
  totp: TotpPort | null;
  /**
   * The invoke port of the `reader` function for the Metrics tab (WPU-G4). null = not configured: the
   * tab says "not available" (R16). Local and test with fakes use a dev reader instead.
   */
  reader: ReaderPort | null;
  /**
   * The invoke port of the `access-details` function (WPU-N2): the Windows and database passwords and
   * the bucket access keys. null = not configured: every reveal and key action refuses (R16). Local
   * and test with fakes use a dev port instead.
   */
  access: AccessPort | null;
  /**
   * The invoke port of the `invoice-renderer` function for "Download PDF" (WPU-N1). null = not
   * configured: the action says "not available" (R16). Local and test with fakes use a dev renderer.
   */
  renderer: RendererPort | null;
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

type OtpParts = NonNullable<WebRuntime["otp"]>;

// The parts of the phone OTP service. The hashing key is read through `pepper`, a getter that is not
// an own enumerable property: JSON and inspect of the runtime never show it (R3), now that a real
// gateway makes these parts exist outside the fakes (WPU-Z3). A spread of the parts drops it, so a
// caller names the fields it passes on (auth-ports.ts).
function otpParts(pepper: string, sms: SmsProvider): OtpParts {
  const parts = { run: withTx, clock: { now: () => new Date() }, sms, limits: OTP_SEND_RULES };
  Object.defineProperty(parts, "pepper", { get: () => pepper, enumerable: false });
  return parts as OtpParts;
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

/**
 * The environment and the secret port are parameters. The secrets default to the SST SDK, which is
 * how a deployed server reads its links (WPU-Z15); the tests hand in their own. Exported for the tests.
 */
export async function assembleRuntime(
  env: Env,
  secret: SecretSource = linkedSecrets(),
  // WPU-X12: the links themselves, for the sign-up client (a linked Cognito client, not a secret).
  links: LinkSource = sstLinks,
): Promise<Assembled> {
  const config = readWebConfig(env);

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
  let totp: TotpPort | null;
  if (process.env.NODE_ENV !== "production" && config.fake.idp) {
    const fake = await import("./fakes/identity.ts");
    identity = fake.createFakeIdentity({ stage: config.stage, fakes: config.fakes });
    const fakeTotp = await import("./fakes/totp.ts");
    totp = fakeTotp.getDevTotp();
  } else {
    try {
      // WPU-X12: sign-up, its confirmation, the resend and the password reset go through the
      // server-only sign-up client (a secret, the only client that may write email); round 4: sign-in and
      // the revocation through the customer client, which has a secret too. The two secrets arrive only
      // as the SST links of the web server function, never as an environment variable and never in a
      // client bundle; the customer link must name the client of COGNITO_CUSTOMER_CLIENT_ID.
      const pool = authConfigFromEnv(env).customer;
      identity = cognitoIdentityProvider(
        pool,
        {
          signUp: signUpClientFromLink(links(SIGN_UP_CLIENT_LINK)),
          customer: customerClientFromLink(links(CUSTOMER_CLIENT_LINK), pool.clientId),
        },
        fetch,
        // A refusing trigger answers "ok" to the page and is logged here as its own fixed reason (no
        // address), so an alarm can match it: someone is asking the public client for codes.
        (fact) =>
          writeLog({
            event: fact.op === "forgotPassword" ? "auth.forgot" : "auth.resend",
            reason: fact.kind,
          }),
      );
    } catch {
      // Pool variables or the sign-up client link missing or malformed: the screens show "not
      // available" (R16). The error is dropped unread: its text is fixed and holds no value.
      identity = null;
    }
    // WPU-X11: the authenticator calls use the customer's own access token on the existing customer
    // client (no secret); they need only the pool variables, not the sign-up client.
    try {
      totp = cognitoTotpPort(authConfigFromEnv(env).customer);
    } catch {
      totp = null;
    }
  }

  let sms: SmsProvider | null = null;
  if (process.env.NODE_ENV !== "production" && config.fake.sms) {
    const outbox = await import("./fakes/outbox.ts");
    sms = outbox.getFakeSms();
  } else if (config.stage === "staging" || config.stage === "production") {
    // WPU-Z3: the SMS gateway (Gennet) with both of its secrets, or no SMS at all (R16). Never in
    // stage local or test, where only the fake sends.
    const apiToken = secret("SmsApiKey");
    const senderId = secret("SmsSenderId");
    if (apiToken !== undefined && senderId !== undefined) {
      sms = new GatewaySmsProvider({ transport: new GennetSmsTransport({ apiToken, senderId }) });
    }
  }
  const otp = sms !== null && otpKey !== null ? otpParts(otpKey, sms) : null;

  // The KYC store and the account changes have no real adapter before the staging VERIFY: only the
  // fakes, only in development and test (the literal condition lets the bundler drop the imports).
  // WPU-Y3: the arrival check is the kyc-check invoke port when KYC_CHECK_FUNCTION_NAME is set; with the
  // fakes, the in-memory stand-in that answers from the fake store.
  let kyc: Omit<KycPorts, "check"> | null = null;
  let kycCheck: KycUploadCheck | null = kycCheckPortFromEnv(env);
  let account: AccountPorts | null = null;
  if (process.env.NODE_ENV !== "production" && config.fakes) {
    const kycFakes = await import("./fakes/kyc-fakes.ts");
    const accountFakes = await import("./fakes/account-fakes.ts");
    const devKyc = kycFakes.getDevKyc();
    kyc = { objects: devKyc.objects, crypto: devKyc.crypto };
    kycCheck = devKyc.check;
    account = accountFakes.getDevAccount();
  }

  // The reader of the Metrics tab: the Lambda invoke port when READER_FUNCTION_NAME is set; a dev
  // reader only in development and test with fakes (the literal condition lets the bundler drop it).
  let reader: ReaderPort | null = readerPortFromEnv(env);
  if (process.env.NODE_ENV !== "production" && config.fakes) {
    const readerFake = await import("./fakes/reader-fake.ts");
    reader = readerFake.devReader();
  }

  // access-details (WPU-N2): the Lambda invoke port when ACCESS_DETAILS_FUNCTION_NAME is set; a dev
  // port with fixed fake values only in development and test with fakes. The literal NODE_ENV
  // condition lets the bundler drop the import, so the production bundle holds no fake.
  let access: AccessPort | null = accessPortFromEnv(env);
  if (process.env.NODE_ENV !== "production" && config.fakes) {
    const accessFake = await import("./fakes/access-fake.ts");
    access = accessFake.devAccess();
  }

  // The same for the invoice renderer (WPU-N1).
  let renderer: RendererPort | null = rendererPortFromEnv(env);
  if (process.env.NODE_ENV !== "production" && config.fakes) {
    const rendererFake = await import("./fakes/renderer-fake.ts");
    renderer = rendererFake.devRenderer();
  }

  return {
    runtime: {
      config,
      eps,
      identity,
      otp,
      authLimitKey,
      kyc,
      kycCheck,
      account,
      totp,
      reader,
      access,
      renderer,
    },
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
