"use server";

import { currentCustomer } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import { revealDatabasePasswordCore } from "../../../../../server/databases-access.ts";
import type { DatabaseRevealResult } from "./DatabaseAccess.tsx";

// R9 in this order: the origin, then the core (authenticate, fresh sign-in, own running database,
// validate, rate limit, execute). The audit row is written by the access-details function. The answer
// is returned to the browser once and holds the secret: nothing here logs or keeps it (U9, R14).
//
// The transport to the access-details function (a direct invocation) is not wired yet, as for the
// Windows password: until it is, `reveal` is null and the core refuses every request (R16). VERIFY at
// deploy time (JOURNEY.md, Needs decision).
const REVEAL_LIMITS = [{ action: "database_password.reveal.web", limit: 20, windowSeconds: 3600 }];

export async function revealDatabasePasswordAction(form: FormData): Promise<DatabaseRevealResult> {
  if (!(await guardAction())) return { ok: false, error: "unauthenticated" };
  const result = await revealDatabasePasswordCore(
    {
      authenticate: async () => {
        const found = await currentCustomer();
        return found.ok ? found.value : null;
      },
      now: () => new Date(),
      // The customer's own row, through the scoped repository, with the family flag on (R8, R12).
      ownedDatabase: (customerId, resourceId) =>
        withTx(async (tx) => {
          const repos = customerRepos(tx, customerId);
          const profile = await repos.profile.get();
          if (profile === null) return null;
          if ((await readFeatureFlag(tx, "database", profile.market)) !== true) return null;
          const row = await repos.resources.get(resourceId);
          return row !== null && row.family === "database" ? row.state : null;
        }),
      rateLimit: (session) =>
        withTx(async (tx) => {
          const decision = await customerRepos(tx, session.customerId).rateLimits.consume(
            REVEAL_LIMITS,
            new Date(),
          );
          return decision.allowed;
        }),
      // TODO(infra): a `RevealPort` (HTTPS function URL with SigV4, or a Lambda client). Until it
      // is decided and wired this stays null and every request is refused (R16).
      reveal: null,
    },
    pick(form, ["resourceId"]),
  );
  return result.ok
    ? { ok: true, username: result.username, password: result.password }
    : { ok: false, error: result.error };
}
