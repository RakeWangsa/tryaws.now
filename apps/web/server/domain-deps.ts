import { currentCustomer } from "@tc/auth";
import { decideTld } from "@tc/core";
import { customerRepos, listTlds, readFeatureFlag, withTx } from "@tc/db";
import { orderActionDeps } from "./action-deps.ts";
import type { DomainActionDeps, DomainDraftDeps } from "./domain-actions.ts";
import type { DomainSearchPort } from "./domain-view.ts";

// The real ports of the domain cores. Only the thin "use server" files and the pages import this (the
// guard of the origin is `guardAction` of action-deps.ts, which runs first).
//
// Two ports are NOT built yet and are null: the availability search (the reader function `checkDomain`
// needs the Route 53 Domains client) and the KMS seal of the registrant contact. With null the search
// says "unavailable" and a draft is refused (R16); the domain flag is off in production (R12) anyway.
// JOURNEY: Needs decision (dependency `@aws-sdk/client-route-53-domains`, KMS key for the seal).
export function domainSearchPort(): DomainSearchPort | null {
  return null;
}

export async function domainDraftDeps(): Promise<DomainDraftDeps> {
  const base = await orderActionDeps();
  return {
    ...base,
    tlds: () =>
      withTx(async (tx) => (await listTlds(tx)).filter((row) => decideTld(row) !== "unavailable")),
    seal: null,
  };
}

export function domainActionDeps(): DomainActionDeps {
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
          domains: repos.domains,
          subscriptions: repos.subscriptions,
          resources: repos.resources,
          operations: repos.operations,
          audit: repos.audit,
          rateLimits: repos.rateLimits,
          // R12, R16: a flag that is off or unreadable is off.
          domainOn: async () => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            return (await readFeatureFlag(tx, "domain", profile.market)) === true;
          },
        });
      }),
  };
}
