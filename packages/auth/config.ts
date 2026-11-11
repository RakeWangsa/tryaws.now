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
