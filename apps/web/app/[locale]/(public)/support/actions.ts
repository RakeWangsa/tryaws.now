"use server";

import { consumeRateLimits, createVisitorSupportRequest, withTx } from "@tc/db";
import { headers } from "next/headers";
import { writeLog } from "../../../../server/log.ts";
import { publicSupportCore } from "../../../../server/public/support-form.ts";
import type {
  PublicSupportContext,
  PublicSupportState,
} from "../../../../server/public/support-form.ts";
import { assertSameOrigin, clientIpOf, requestId } from "../../../../server/request.ts";
import { getRuntime } from "../../../../server/runtime.ts";

/** The Server Action of the public support form. Every throw is one generic state: no text of the error (R14, R16). */
export async function publicSupportAction(
  _previous: PublicSupportState,
  data: FormData,
): Promise<PublicSupportState> {
  const ref = requestId();
  try {
    const [h, runtime] = await Promise.all([headers(), getRuntime()]);
    const ctx: PublicSupportContext = {
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
      create: async (input) => {
        const written = await withTx((tx) => createVisitorSupportRequest(tx, input));
        return written.ok
          ? { ok: true, replayed: written.replayed }
          : { ok: false, replayed: false };
      },
      log: (event, reason) => writeLog({ event, reason, requestId: ref }),
    };
    return await publicSupportCore(ctx, Object.fromEntries(data.entries()));
  } catch {
    return { status: "error", code: "unavailable", ref };
  }
}
