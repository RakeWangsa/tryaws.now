import { parseCidr } from "./admin-ip";

export const FRESH_SIGN_IN_MINUTES = 10; // 6.1
export const REFRESH_WINDOW_SECONDS = 300; // open point 4
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 2_592_000; // 30 days; must match the app client (VERIFY 3)
export const CLOCK_SKEW_SECONDS = 60; // an auth_time this far in the future is refused

export interface PoolConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
}

export interface AuthConfig {
  readonly customer: PoolConfig;
  readonly refreshWindowSeconds: number;
  readonly refreshCookieMaxAgeSeconds: number;
}

const POOL_ID = /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/;
const CLIENT_ID = /^[A-Za-z0-9]{10,64}$/;

export const ADMIN_SESSION_SECONDS = 28_800; // 6.2: sessions of 8 hours

export interface AdminAuthConfig {
  readonly admin: PoolConfig;
  // CIDR blocks or single addresses; the second wall behind WAF (6.2).
  readonly allowlist: readonly string[];
}

// The admin pool and the allowlist, from the environment. An empty or unreadable allowlist is an
// error, never "allow all" (R16). Error texts are fixed.
export function adminAuthConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AdminAuthConfig {
  const userPoolId = env["COGNITO_ADMIN_POOL_ID"];
  const clientId = env["COGNITO_ADMIN_CLIENT_ID"];
  if (typeof userPoolId !== "string" || !POOL_ID.test(userPoolId)) {
    throw new TypeError("auth config: COGNITO_ADMIN_POOL_ID is missing or malformed");
  }
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
    throw new TypeError("auth config: COGNITO_ADMIN_CLIENT_ID is missing or malformed");
  }
  const raw = env["ADMIN_IP_ALLOWLIST"];
  const entries =
    typeof raw === "string"
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];
  if (entries.length === 0 || entries.some((e) => parseCidr(e) === null)) {
    throw new TypeError("auth config: ADMIN_IP_ALLOWLIST is missing or malformed");
  }
  return {
    admin: { region: userPoolId.slice(0, userPoolId.indexOf("_")), userPoolId, clientId },
    allowlist: entries,
  };
}

// WPU-X12: the server-only sign-up client of the customer pool (infra/stacks/auth.ts
// CustomerSignUpClient). It is the only client that may write email, name and locale, and it has a
// secret, so only the web server, which knows the secret, can call SignUp, ConfirmSignUp and
// ResendConfirmationCode with it. The token-issuing customer client may write only name, so a stolen
// customer access token cannot change the e-mail (the login name and recovery channel) at Cognito.
// Round 4: the token-issuing customer client has a secret too (CustomerAppClient), so Cognito itself
// refuses SignUp, Resend and ForgotPassword through it for anyone who does not hold the secret.
export interface ClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}
export type SignUpClientConfig = ClientCredentials;

/** The names of the SST links (the Cognito client components) that carry `id` and `secret`. */
export const SIGN_UP_CLIENT_LINK = "CustomerSignUpClient";
export const CUSTOMER_CLIENT_LINK = "CustomerAppClient";

// Cognito generates secrets of lowercase letters and digits; a custom one is [\w+]{24,64}
// (CreateUserPoolClient, ClientSecret). Anything else is a wrong value, never a usable one.
const CLIENT_SECRET = /^[A-Za-z0-9_+]{24,128}$/;

// The id and the secret from the properties of a linked client component (SST CognitoUserPoolClient
// getSSTLink: { id, secret }). The link is a parameter: the caller reads it through @tc/db/links, so this
// file loads no SDK. Missing or malformed is an error with a fixed text, which holds neither value
// (R3, R14, R16); the caller then has no sign-up and the screens say "not available".
function credentialsFromLink(link: unknown, label: string): ClientCredentials {
  const props =
    typeof link === "object" && link !== null ? (link as Record<string, unknown>) : undefined;
  const clientId = props?.["id"];
  const clientSecret = props?.["secret"];
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
    throw new TypeError(`auth config: ${label} id is missing or malformed`);
  }
  if (typeof clientSecret !== "string" || !CLIENT_SECRET.test(clientSecret)) {
    throw new TypeError(`auth config: ${label} secret is missing or malformed`);
  }
  return { clientId, clientSecret };
}

export function signUpClientFromLink(link: unknown): ClientCredentials {
  return credentialsFromLink(link, SIGN_UP_CLIENT_LINK);
}

// The customer client's secret from its link. Its id stays an environment value (the proxy and the
// token verifier read COGNITO_CUSTOMER_CLIENT_ID), so the link must name that same client: a link of
// another client would sign people in with the wrong secret and is refused.
export function customerClientFromLink(link: unknown, expectedClientId: string): ClientCredentials {
  const found = credentialsFromLink(link, CUSTOMER_CLIENT_LINK);
  if (found.clientId !== expectedClientId) {
    throw new TypeError(`auth config: ${CUSTOMER_CLIENT_LINK} id is not the customer client`);
  }
  return found;
}

// The environment is a parameter so the package never reads process.env on its own. Error texts are
// fixed: a rejected value may be a mistyped secret and must not reach a log (R14, R16).
export function authConfigFromEnv(env: Readonly<Record<string, string | undefined>>): AuthConfig {
  const userPoolId = env["COGNITO_CUSTOMER_POOL_ID"];
  const clientId = env["COGNITO_CUSTOMER_CLIENT_ID"];
  if (typeof userPoolId !== "string" || !POOL_ID.test(userPoolId)) {
    throw new TypeError("auth config: COGNITO_CUSTOMER_POOL_ID is missing or malformed");
  }
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
    throw new TypeError("auth config: COGNITO_CUSTOMER_CLIENT_ID is missing or malformed");
  }
  const region = userPoolId.slice(0, userPoolId.indexOf("_"));
  return {
    customer: { region, userPoolId, clientId },
    refreshWindowSeconds: REFRESH_WINDOW_SECONDS,
    refreshCookieMaxAgeSeconds: REFRESH_COOKIE_MAX_AGE_SECONDS,
  };
}
