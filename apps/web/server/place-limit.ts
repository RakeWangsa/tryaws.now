import { customerRepos } from "@tc/db";
import type { CustomerLimit, Tx } from "@tc/db";

// WPU-X11 follow-up (final review, LOW). The customer's limiter (`rateLimits.consume`) counts the rules of a
// call in key order and, as the limiter of the database is documented to do, does NOT undo the ones counted
// before a refusal. The purchase limit has two rules of one action, `order.place.web:3600` and
// `order.place.web:60`, and the hour key sorts first, so a purchase refused by the per-minute rule still used
// one of the 60 an hour: a double click or a script could lock a customer out for the hour.
//
// This runs the consume inside one transaction and throws on a refusal, so the transaction rolls back and a
// refused purchase counts nothing (the pattern of reserveAuthLimit of the sign-in). Any other failure
// propagates: the caller refuses as unavailable (R16). The customer id is the session's (R8).

class Refused extends Error {
  constructor() {
    super("rate limit: refused");
  }
}

export async function consumeAllOrNothing(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  customerId: string,
  limits: readonly CustomerLimit[],
  now: Date,
): Promise<{ allowed: boolean }> {
  try {
    await run(async (tx) => {
      const decision = await customerRepos(tx, customerId).rateLimits.consume(limits, now);
      if (!decision.allowed) throw new Refused();
    });
    return { allowed: true };
  } catch (error) {
    if (error instanceof Refused) return { allowed: false };
    throw error;
  }
}
