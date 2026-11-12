"use server";

import { consumeRateLimits, joinVisitorWaitlist, readFeatureFlag, withTx } from "@tc/db";
import { headers } from "next/headers";
import { PUBLIC_MARKET } from "../../../../../server/public/catalog.ts";
import { notifyMeCore } from "../../../../../server/public/notify-me.ts";
import type { NotifyMeContext, NotifyMeState } from "../../../../../server/public/notify-me.ts";
import { writeLog } from "../../../../../server/log.ts";
import { assertSameOrigin, clientIpOf, requestId } from "../../../../../server/request.ts";
import { getRuntime } from "../../../../../server/runtime.ts";

/** The Server Action of the "notify me" form. Every throw is one generic state: no text of the error (R14, R16). */
export async function notifyMeAction(
  _previous: NotifyMeState,
  data: FormData,
): Promise<NotifyMeState> {
  const ref = requestId();
  try {
    const [h, runtime] = await Promise.all([headers(), getRuntime()]);
    const ctx: NotifyMeContext = {
      sameOrigin: () => assertSameOrigin(h, runtime.config),
      ip: clientIpOf(h, runtime.config),
      limitKey: runtime.authLimitKey,
      ref,
      limit: async (rules) => {
        // One transaction that always commits, so the counters of the rules before a refusing one stay counted.
        const decision = await withTx((tx) => consumeRateLimits(tx, rules, new Date()));
        return decision.allowed
          ? { allowed: true }
          : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
      },
      flag: (key) => withTx((tx) => readFeatureFlag(tx, key, PUBLIC_MARKET)),
      join: async (input) => {
        const written = await withTx((tx) => joinVisitorWaitlist(tx, input));
        return written.ok
          ? { ok: true, replayed: written.replayed }
          : { ok: false, replayed: false };
      },
      log: (event, reason) => writeLog({ event, reason, requestId: ref }),
    };
    return await notifyMeCore(ctx, Object.fromEntries(data.entries()));
  } catch {
    return { status: "error", code: "unavailable", ref };
  }
}
