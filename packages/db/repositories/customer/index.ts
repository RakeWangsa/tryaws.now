import type { Tx } from "../../client";
import { tenantScope } from "../scope";
import { profileRepo, type ProfileRepo } from "./profile";
import { auditRepo, type AuditRepo } from "./audit";
import { sshKeysRepo, type SshKeysRepo } from "./ssh-keys";
import { resourcesRepo, type ResourcesRepo } from "./resources";
import { operationsRepo, type OperationsRepo } from "./operations";
import { homesRepo, type HomesRepo } from "./homes";
import { waitlistRepo, type WaitlistRepo } from "./waitlist";
import { rateLimitsRepo, type RateLimitsRepo } from "./rate-limits";
import { otpRepo, type OtpRepo } from "./otp";
import { paymentsRepo, type PaymentsRepo } from "./payments";
import { ordersRepo, type OrdersRepo } from "./orders";
import { walletRepo, type WalletRepo } from "./wallet";

// The repositories of one customer (R8). Tasks 7 to 9 add sshKeys, resources, operations, audit.
export interface CustomerRepos {
  profile: ProfileRepo;
  audit: AuditRepo;
  sshKeys: SshKeysRepo;
  resources: ResourcesRepo;
  operations: OperationsRepo;
  homes: HomesRepo;
  waitlist: WaitlistRepo;
  rateLimits: RateLimitsRepo;
  otp: OtpRepo;
  payments: PaymentsRepo;
  orders: OrdersRepo;
  wallet: WalletRepo;
}

// Binds the customer once; every repository is built from that scope and no method takes a
// customer id. Throws a TypeError for a customer id that is not a UUID (R16). Sends no query.
export function customerRepos(tx: Tx, customerId: string): CustomerRepos {
  const scope = tenantScope(tx, customerId);
  return {
    profile: profileRepo(scope),
    audit: auditRepo(scope),
    sshKeys: sshKeysRepo(scope),
    resources: resourcesRepo(scope),
    operations: operationsRepo(scope),
    homes: homesRepo(scope),
    waitlist: waitlistRepo(scope),
    rateLimits: rateLimitsRepo(scope),
    otp: otpRepo(scope),
    payments: paymentsRepo(scope),
    orders: ordersRepo(scope),
    wallet: walletRepo(scope),
  };
}

// The methods of R whose input mentions a customer id (as "customerId" or "customer_id", at any
// depth, also inside an array). test/customer-repos.types.ts requires this to be never for
// CustomerRepos. A string key of a Record<string, unknown> is not a mention, so a free-form
// `metadata` object is fine.
type LiteralKeys<T> = string extends keyof T ? never : keyof T;
type Mentions<T> = T extends string | number | bigint | boolean | null | undefined | Date
  ? false
  : T extends readonly (infer U)[]
    ? Mentions<U>
    : T extends object
      ? [Extract<LiteralKeys<T>, "customerId" | "customer_id">] extends [never]
        ? true extends { [K in LiteralKeys<T>]-?: Mentions<T[K]> }[LiteralKeys<T>]
          ? true
          : false
        : true
      : false;
export type MethodsTakingCustomerId<R> = {
  [Repo in keyof R]: {
    [M in keyof R[Repo]]: R[Repo][M] extends (...args: infer A) => unknown
      ? true extends Mentions<A[number]>
        ? `${Repo & string}.${M & string}`
        : never
      : never;
  }[keyof R[Repo]];
}[keyof R];
