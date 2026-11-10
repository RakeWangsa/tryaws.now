import type { LightsailClientConfig } from "@aws-sdk/client-lightsail";
import type { RoleName } from "./roles";

export const STS_REGION = "ap-southeast-1";
export const SESSION_SECONDS = 3600;
export const REFRESH_MARGIN_MS = 300_000;
export const CONNECTION_TIMEOUT_MS = 3_000;
export const REQUEST_TIMEOUT_MS = 15_000;

export const MUTATING_ROLES = Object.freeze([
  "TcProvisioner",
  "TcDnsProvisioner",
  "TcAccessDetails",
] as const);

export type RetryStrategyV2 = Extract<
  NonNullable<LightsailClientConfig["retryStrategy"]>,
  { refreshRetryTokenForRetry: unknown }
>;

function token(retryCount: number, retryDelay: number) {
  return {
    getRetryCount: () => retryCount,
    getRetryDelay: () => retryDelay,
  };
}

/**
 * Repeats a call only when AWS throttled it (AWS does not run a throttled request). A timeout,
 * a 5xx or a network error is never repeated: AWS may already have acted on the call.
 */
export function throttlingOnlyRetryStrategy(maxAttempts = 3): RetryStrategyV2 {
  return {
    acquireInitialRetryToken: async () => token(0, 0),
    refreshRetryTokenForRetry: async (previous, errorInfo) => {
      const n = previous.getRetryCount() + 1;
      if (errorInfo.errorType !== "THROTTLING" || n >= maxAttempts) {
        throw new Error("retry refused");
      }
      const delay = Math.floor(Math.random() * Math.min(20_000, 1_000 * 2 ** (n - 1)));
      return token(n, delay);
    },
    recordSuccess: () => {},
  };
}

export const TIME_LIMITS = Object.freeze({
  connectionTimeout: CONNECTION_TIMEOUT_MS,
  requestTimeout: REQUEST_TIMEOUT_MS,
  throwOnRequestTimeout: true,
} as const);

export function clientSettings(
  target: RoleName | "sts",
): { maxAttempts: 3; requestHandler: typeof TIME_LIMITS } & (
  { retryMode: "standard" } | { retryStrategy: RetryStrategyV2 }
) {
  // A new object on every call: the SDK may change the object it is given.
  const requestHandler = { ...TIME_LIMITS };
  if ((MUTATING_ROLES as readonly string[]).includes(target)) {
    return { maxAttempts: 3, retryStrategy: throttlingOnlyRetryStrategy(), requestHandler };
  }
  return { maxAttempts: 3, retryMode: "standard", requestHandler };
}
