import {
  createAwsAccess,
  createBucketAccessKey,
  fetchDatabasePassword,
  fetchWindowsPassword,
  listBucketAccessKeys,
} from "@tc/aws";
import type { Clock, Logger } from "@tc/core";
import { customerRepos, loadReadTarget, type ReadTarget, type Tx } from "@tc/db";
import { createAccessDetails, type AccessDetails, type RateAction } from "./handler";
import { createInvoke } from "./invoke";

export interface AccessDetailsEnv {
  readonly clock: Clock;
  readonly runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly log: Logger;
}

// Per customer and hour: a password is read on demand, not polled; a bucket has two keys at most.
const LIMITS: Readonly<Record<RateAction, number>> = Object.freeze({
  "windows_password.reveal": 20,
  "database_password.reveal": 20,
  "bucket_key.create": 10,
  "bucket_key.list": 60,
});

// The unique claim of a request id (R7) on the atomic counter of rate_limits: a limit of one hit per
// day under an action made of the request id, so the first call is allowed and every later one is not.
// The action pattern allows 48 characters: "bucket_key.r." plus the 32 hex digits of the id.
export function claimActionOf(requestId: string): string {
  return `bucket_key.r.${requestId.replaceAll("-", "")}`;
}

const params = (target: ReadTarget) => ({
  account: target.account,
  region: target.region as never,
  resourceId: target.resource.id,
  resourceState: target.resource.state,
});

// Assembles the function from values handed in: no environment access, no global clock. The tenant
// check, the rate limit and the audit row each run in a short transaction of their own, and AWS is
// never called inside a transaction.
export function buildAccessDetails(env: AccessDetailsEnv): {
  access: AccessDetails;
  handler: ReturnType<typeof createInvoke>;
} {
  const awsAccess = createAwsAccess({ caller: "access-details", clock: env.clock });
  const access = createAccessDetails({
    loadTarget: (caller, resourceId) =>
      env.runTx((tx) => loadReadTarget(tx, { customerId: caller.customerId }, resourceId)),
    rateLimit: (customerId, action) =>
      env.runTx(async (tx) => {
        const decision = await customerRepos(tx, customerId).rateLimits.consume(
          [Object.freeze({ action, limit: LIMITS[action], windowSeconds: 3600 })],
          env.clock.now(),
        );
        return decision.allowed;
      }),
    claimRequest: (customerId, requestId) =>
      env.runTx(async (tx) => {
        const decision = await customerRepos(tx, customerId).rateLimits.consume(
          [Object.freeze({ action: claimActionOf(requestId), limit: 1, windowSeconds: 86_400 })],
          env.clock.now(),
        );
        return decision.allowed;
      }),
    windowsPassword: (target) => fetchWindowsPassword({ access: awsAccess, ...params(target) }),
    databasePassword: (target) => fetchDatabasePassword({ access: awsAccess, ...params(target) }),
    bucketKeyCreate: (target) => createBucketAccessKey({ access: awsAccess, ...params(target) }),
    bucketKeyList: (target) => listBucketAccessKeys({ access: awsAccess, ...params(target) }),
    audit: (entry) =>
      env.runTx(async (tx) => {
        const written = await customerRepos(tx, entry.customerId).audit.record({
          action: entry.action,
          targetType: "resource",
          targetId: entry.resourceId,
        });
        if (!written.ok) throw new Error("access-details: the audit entry was refused");
      }),
    log: env.log,
  });
  return { access, handler: createInvoke(access) };
}
