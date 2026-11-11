"use server";

import { currentCustomer } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import { revealWindowsPasswordCore } from "../../../../../server/windows-access.ts";
import type { RevealResult } from "./WindowsAccess.tsx";

// R9 in this order: the origin, then the core (authenticate, fresh sign-in, validate, rate limit,
// execute). The audit row is written by the access-details function. The answer is returned to the
// browser once and holds the secret: nothing here logs or keeps it (U9, R14).
//
// The transport to the access-details function (a direct Lambda invocation) is not wired yet: until it
// is, `reveal` is null and the core refuses every request (R16). VERIFY at deploy time.
const REVEAL_LIMITS = [{ action: "windows_password.reveal", limit: 20, windowSeconds: 3600 }];

export async function revealWindowsPasswordAction(form: FormData): Promise<RevealResult> {
  if (!(await guardAction())) return { ok: false, error: "unauthenticated" };
  const result = await revealWindowsPasswordCore(
    {
      authenticate: async () => {
        const found = await currentCustomer();
        return found.ok ? found.value : null;
      },
      now: () => new Date(),
      rateLimit: (session) =>
        withTx(async (tx) => {
          const decision = await customerRepos(tx, session.customerId).rateLimits.consume(
            REVEAL_LIMITS,
            new Date(),
          );
          return decision.allowed;
        }),
      reveal: null,
    },
    pick(form, ["resourceId"]),
  );
  return result.ok
    ? { ok: true, username: result.username, password: result.password }
    : { ok: false, error: result.error };
}
