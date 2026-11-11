import { currentCustomer } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import type { CdnActionDeps } from "./cdn-actions.ts";

// The real ports of the CDN cores. Only the thin "use server" files import this (the guard of the
// origin is `guardAction` of action-deps.ts, which runs first).

/** The ports of setCdnEnabledCore and destroyCdnCore (cdn-actions.ts). */
export function cdnActionDeps(): CdnActionDeps {
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
          cdnOn: async () => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            return (await readFeatureFlag(tx, "cdn", profile.market)) === true;
          },
        });
      }),
  };
}
