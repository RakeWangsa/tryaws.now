import { currentCustomer } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import { headers } from "next/headers";
import type { ExtrasDeps } from "./extras-actions.ts";
import type { KeyActionDeps } from "./key-actions.ts";
import { DRAFT_RATE_LIMITS } from "./order-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";
import { getOrdersRuntime } from "./orders-runtime.ts";
import { assertSameOrigin } from "./request.ts";
import { getRuntime } from "./runtime.ts";

// The real ports of the cores of the Server Actions. Only the thin "use server" files import this.
// R9 step one is in the core (`authenticate`); the origin check here is the second line next to the
// one of Next.js, and it runs before any core.

/** Starts the runtime (which configures sign-in) and refuses a request from another origin (R9, R16). */
export async function guardAction(): Promise<boolean> {
  const { config } = await getRuntime();
  return assertSameOrigin(await headers(), config);
}

async function authenticate() {
  const found = await currentCustomer();
  return found.ok ? found.value : null;
}

export async function orderActionDeps(): Promise<OrderActionDeps> {
  const runtime = await getOrdersRuntime();
  return {
    authenticate,
    rateLimit: (session) =>
      withTx((tx) =>
        customerRepos(tx, session.customerId).rateLimits.consume(DRAFT_RATE_LIMITS, new Date()),
      ),
    orders: runtime === null ? null : runtime.orders,
  };
}

export function keyActionDeps(): KeyActionDeps {
  return {
    authenticate,
    now: () => new Date(),
    store: (customerId, fn) =>
      withTx((tx) => {
        const repos = customerRepos(tx, customerId);
        return fn({ sshKeys: repos.sshKeys, audit: repos.audit, rateLimits: repos.rateLimits });
      }),
  };
}

/** The ports of the cores of the server tabs and the bell (extras-actions.ts). */
export function extrasActionDeps(): ExtrasDeps {
  return {
    authenticate,
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
          notifications: repos.notifications,
          // R12, R16: a flag that is off or unreadable is off.
          serversOn: async () => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            return (await readFeatureFlag(tx, "linux_instance", profile.market)) === true;
          },
        });
      }),
  };
}
