import { currentCustomer } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import type { FamilyActionDeps } from "./bucket-frame.ts";
import type { BucketKeysDeps } from "./bucket-keys.ts";

// The real ports of the cores of the object storage and container screens. Only the thin "use
// server" files import this (the guard of the origin is `guardAction` of action-deps.ts, which runs
// first). `flag` is the feature flag of the family (R12).

export function familyActionDeps(flag: string): FamilyActionDeps {
  return {
    authenticate: async () => {
      const found = await currentCustomer();
      return found.ok ? found.value : null;
    },
    now: () => new Date(),
    store: (customerId, fn) =>
      withTx((tx) => {
        const repos = customerRepos(tx, customerId);
        return fn({
          resources: repos.resources,
          subscriptions: repos.subscriptions,
          operations: repos.operations,
          audit: repos.audit,
          rateLimits: repos.rateLimits,
          // R12, R16: a flag that is off or unreadable is off.
          flagOn: async () => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            return (await readFeatureFlag(tx, flag, profile.market)) === true;
          },
        });
      }),
  };
}

const KEY_LIMITS = [{ action: "bucket_key.create.web", limit: 10, windowSeconds: 3600 }];

/**
 * The ports of createBucketKeyCore. The transport to the access-details function (a direct Lambda
 * invocation) is not wired yet: until it is, `createKey` is null and the core refuses every request
 * (R16). TODO(infra): a `CreateKeyPort` (HTTPS function URL with SigV4, or a Lambda client; no
 * dependency is added without a recorded reason, R17). VERIFY at deploy time.
 */
export function bucketKeysDeps(): BucketKeysDeps {
  return {
    authenticate: async () => {
      const found = await currentCustomer();
      return found.ok ? found.value : null;
    },
    now: () => new Date(),
    rateLimit: (session) =>
      withTx(async (tx) => {
        const decision = await customerRepos(tx, session.customerId).rateLimits.consume(
          KEY_LIMITS,
          new Date(),
        );
        return decision.allowed;
      }),
    createKey: null,
  };
}
