import { currentCustomer } from "@tc/auth";
import { renewNow } from "@tc/core";
import { customerRepos, newUuidV7, readFeatureFlag, withTx } from "@tc/db";
import { headers } from "next/headers";
import type { ExtrasDeps } from "./extras-actions.ts";
import type { KeyActionDeps } from "./key-actions.ts";
import type { KycActionDeps } from "./kyc-actions.ts";
import type { ServerOpsDeps } from "./server-actions.ts";
import type { SettingsDeps } from "./settings-actions.ts";
import type { SupportActionDeps } from "./support-actions.ts";
import { DRAFT_RATE_LIMITS } from "./order-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";
import { getOrdersRuntime } from "./orders-runtime.ts";
import { assertSameOrigin, clientIpOf } from "./request.ts";
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

export async function kycActionDeps(): Promise<KycActionDeps> {
  const { kyc } = await getRuntime();
  return {
    authenticate,
    now: () => new Date(),
    newId: newUuidV7,
    store: (customerId, fn) =>
      withTx((tx) => {
        const repos = customerRepos(tx, customerId);
        return fn({ kyc: repos.kyc, audit: repos.audit, rateLimits: repos.rateLimits });
      }),
    ports: kyc,
  };
}

export async function settingsActionDeps(): Promise<SettingsDeps> {
  const { account, config } = await getRuntime();
  const ip = clientIpOf(await headers(), config);
  return {
    authenticate,
    now: () => new Date(),
    store: (customerId, fn) =>
      withTx((tx) => {
        const repos = customerRepos(tx, customerId);
        return fn({ profile: repos.profile, audit: repos.audit, rateLimits: repos.rateLimits });
      }),
    ports: account,
    clientIp: () => ip,
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
          renewNow: (resourceId) =>
            renewNow(tx, { customerId, resourceId, clock: { now: () => new Date() } }),
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

/**
 * The ports of the cores of the server header and the Networking tab (server-actions.ts, WPU-G2).
 * R12, R16: the flag of the server's own family, and a flag that is off or unreadable is off.
 */
export function serverOpsActionDeps(): ServerOpsDeps {
  return {
    authenticate,
    now: () => new Date(),
    store: (customerId, fn) =>
      withTx((tx) => {
        const repos = customerRepos(tx, customerId);
        return fn({
          resources: repos.resources,
          operations: repos.operations,
          audit: repos.audit,
          rateLimits: repos.rateLimits,
          familyOn: async (family) => {
            const profile = await repos.profile.get();
            if (profile === null) return false;
            return (await readFeatureFlag(tx, family, profile.market)) === true;
          },
        });
      }),
  };
}

/** The ports of createSupportRequestCore (16.10 /support, WP9-T4b): the customer's own repositories. */
export function supportActionDeps(): SupportActionDeps {
  return {
    authenticate,
    now: () => new Date(),
    store: (customerId, fn) =>
      withTx((tx) => {
        const repos = customerRepos(tx, customerId);
        return fn({
          support: {
            create: async (input) => {
              const written = await repos.support.create(input);
              return written.ok
                ? { ok: true, id: written.value.id, replayed: written.replayed }
                : { ok: false, error: written.error };
            },
          },
          audit: repos.audit,
          rateLimits: repos.rateLimits,
        });
      }),
  };
}
