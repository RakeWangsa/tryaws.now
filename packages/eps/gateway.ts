import { inspect } from "node:util";
import type { VerifyReading } from "./status";

export interface EpsCredentials {
  readonly mode: "production" | "sandbox";
  readonly merchantId: string;
  readonly storeId: string;
  readonly username: string;
  readonly password: string;
  readonly hashKey: string;
}

const REDACTED = "[eps credentials]";

/**
 * Returns a frozen copy whose toString, toJSON and util.inspect print "[eps credentials]",
 * so a logged object leaks nothing (R3, R14). The package never reads process.env; the caller passes the values.
 */
export function epsCredentials(input: EpsCredentials): EpsCredentials {
  if (input.mode !== "production" && input.mode !== "sandbox")
    throw new TypeError("eps credentials: bad mode");
  for (const k of ["merchantId", "storeId", "username", "password", "hashKey"] as const) {
    if (typeof input[k] !== "string" || input[k].length === 0)
      throw new TypeError(`eps credentials: empty ${k}`);
  }
  const copy: EpsCredentials = {
    mode: input.mode,
    merchantId: input.merchantId,
    storeId: input.storeId,
    username: input.username,
    password: input.password,
    hashKey: input.hashKey,
  };
  const hidden = { enumerable: false, writable: false, configurable: false } as const;
  Object.defineProperties(copy, {
    toString: { ...hidden, value: () => REDACTED },
    toJSON: { ...hidden, value: () => REDACTED },
    [inspect.custom]: { ...hidden, value: () => REDACTED },
  });
  return Object.freeze(copy);
}

export interface InitializeRequest {
  merchantTransactionId: string;
  customerOrderId: string;
  totalAmountMinor: bigint;
  ipAddress: string;
  productName: string;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
}

/** rejected: EPS answered with an error code. unavailable: timeout, network, 401 after one refresh, malformed answer, non-https or off-host RedirectURL. */
export type InitializeResult =
  | { ok: true; redirectUrl: string; gatewayTransactionId: string | null }
  | { ok: false; reason: "rejected" | "unavailable" };

export type VerifyResult =
  { ok: true; reading: VerifyReading } | { ok: false; reason: "unavailable" };

export interface EpsGateway {
  initialize(req: InitializeRequest): Promise<InitializeResult>;
  verify(merchantTransactionId: string): Promise<VerifyResult>;
}
