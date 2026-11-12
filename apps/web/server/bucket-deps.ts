import { currentCustomer } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import type { AccessPort } from "./access-invoke.ts";
import { displayNameOf, type FamilyActionDeps } from "./bucket-frame.ts";
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

const KEY_LIMITS = {
  "bucket_key.create": [{ action: "bucket_key.create.web", limit: 10, windowSeconds: 3600 }],
  "bucket_key.list": [{ action: "bucket_key.list.web", limit: 60, windowSeconds: 3600 }],
} as const;

/**
 * The ports of createBucketKeyCore and listBucketKeysCore. The transport to the access-details
 * function is the invoke port of access-invoke.ts (WPU-N2); with no port (not configured) both cores
 * refuse every request (R16). The bucket is read through the scoped repository of the session's
 * customer with the family flag on (R8, R12).
 */
export function bucketKeysDeps(port: AccessPort | null): BucketKeysDeps {
  return {
    authenticate: async () => {
      const found = await currentCustomer();
      return found.ok ? found.value : null;
    },
    now: () => new Date(),
    ownedBucket: (customerId, bucketId) =>
      withTx(async (tx) => {
        const repos = customerRepos(tx, customerId);
        const profile = await repos.profile.get();
        if (profile === null) return null;
        if ((await readFeatureFlag(tx, "bucket", profile.market)) !== true) return null;
        const row = await repos.resources.get(bucketId);
        if (row === null || row.family !== "bucket") return null;
        return { state: row.state, name: displayNameOf(row.config) };
      }),
    rateLimit: (session, action) =>
      withTx(async (tx) => {
        const decision = await customerRepos(tx, session.customerId).rateLimits.consume(
          KEY_LIMITS[action],
          new Date(),
        );
        return decision.allowed;
      }),
    createKey: port === null ? null : (input) => port.bucketKeyCreate(input),
    listKeys: port === null ? null : (input) => port.bucketKeyList(input),
  };
}
