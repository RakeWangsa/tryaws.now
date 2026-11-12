import { currentCustomer } from "@tc/auth";
import { snapshotPrice } from "@tc/core";
import { customerRepos, readCatalogProduct, readFeatureFlag, withTx } from "@tc/db";
import type { FamilyActionDeps } from "./family-actions.ts";

// The real ports of the family cores (database, load balancer). Only the thin "use server" files
// import this (the guard of the origin is `guardAction` of action-deps.ts, which runs first).

/** The ports of the cores of family-actions.ts for the product flag `flag`. */
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
          catalogProduct: (id) => readCatalogProduct(tx, id),
          // R12, R16: a flag that is off or unreadable is off.
          flagOn: async () => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            return (await readFeatureFlag(tx, flag, profile.market)) === true;
          },
          // WPU-G9: the price must exist AND be priceable by the engine (rate and rule in force).
          snapshotPriceOn: async () => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            const priced = await snapshotPrice(tx, profile.market, null, { now: () => new Date() });
            return priced.ok;
          },
        });
      }),
  };
}
