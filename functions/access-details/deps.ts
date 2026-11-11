import { createAwsAccess, fetchWindowsPassword } from "@tc/aws";
import type { Clock, Logger } from "@tc/core";
import { customerRepos, loadReadTarget, type Tx } from "@tc/db";
import { createAccessDetails, type AccessDetails } from "./handler";
import { createInvoke } from "./invoke";

export interface AccessDetailsEnv {
  readonly clock: Clock;
  readonly runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly log: Logger;
}

// 20 reveals in an hour per customer: a password is read on demand, not polled.
const REVEAL_LIMITS = Object.freeze([
  Object.freeze({ action: "windows_password.reveal", limit: 20, windowSeconds: 3600 }),
]);

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
    rateLimit: (customerId) =>
      env.runTx(async (tx) => {
        const decision = await customerRepos(tx, customerId).rateLimits.consume(
          REVEAL_LIMITS,
          env.clock.now(),
        );
        return decision.allowed;
      }),
    windowsPassword: (target) =>
      fetchWindowsPassword({
        access: awsAccess,
        account: target.account,
        region: target.region as never,
        resourceId: target.resource.id,
        resourceState: target.resource.state,
      }),
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
