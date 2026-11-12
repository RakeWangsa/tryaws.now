"use server";

import { currentCustomer } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import { getAccessPort } from "../../../../../server/access-port.ts";
import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import { revealWindowsPasswordCore } from "../../../../../server/windows-access.ts";
import type { RevealResult } from "./WindowsAccess.tsx";

// R9 in this order: the origin, then the core (authenticate, fresh sign-in, validate, rate limit,
// execute). The audit row is written by the access-details function. The answer is returned to the
// browser once and holds the secret: nothing here logs or keeps it (U9, R14).
//
// The transport to the access-details function is the invoke port of server/access-invoke.ts (WPU-N2).
// L4 (WPU-B7): the web tier counts under its own action name. The access-details function counts under
// "windows_password.reveal" for the same customer, so one reveal is one hit in each, not two in one: the
// effective limit stays 20 an hour.
const REVEAL_LIMITS = [{ action: "windows_password.reveal.web", limit: 20, windowSeconds: 3600 }];

export async function revealWindowsPasswordAction(form: FormData): Promise<RevealResult> {
  if (!(await guardAction())) return { ok: false, error: "unauthenticated" };
  const port = await getAccessPort();
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
      // The customer's own Windows server, through the scoped repository (R8).
      ownedWindows: (customerId, resourceId) =>
        withTx(async (tx) => {
          const row = await customerRepos(tx, customerId).resources.get(resourceId);
          return row !== null && row.family === "windows_instance" ? row.state : null;
        }),
      // WPU-N2: the invoke port of access-details (the "web" alias); null when it is not configured,
      // and the core then refuses every request (R16).
      reveal: port === null ? null : (input) => port.windowsPassword(input),
    },
    pick(form, ["resourceId"]),
  );
  return result.ok
    ? { ok: true, username: result.username, password: result.password }
    : { ok: false, error: result.error };
}
