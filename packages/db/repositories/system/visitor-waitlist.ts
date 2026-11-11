import { sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { Tx } from "../../client";
import { created, refused, replayed, type Written } from "../result";

// The "notify me" of a product page whose flag is off (16.8, 16.13). A visitor has no customer id,
// so the row names the person by e-mail only (`waitlist_entries.customer_id` is null, the table's
// recipient check allows it). Like registration.ts this is a system module, not part of
// customerRepos: no function of it takes a customer id, and it reads nothing. web_rw may INSERT
// exactly these columns (migration 0006), so there is no RETURNING and no conflict target; the id is
// the idempotency key (R7): the same address and family always give the same id, and a second call
// does nothing. The caller validates, rate limits and audits first (R9).

export const VISITOR_WAITLIST_NAMESPACE = "6c3f2a70-8f1e-4a0b-9e55-0d7b2c1a4e91";

/** The Region of the first launch location. A flag-off product has no Region yet; the entries share this one. */
export const VISITOR_WAITLIST_REGION = "ap-southeast-1";

export interface VisitorWaitlistJoin {
  /** Any case; stored lower-case. */
  email: string;
  /** The catalog family, which is also the feature flag key (for example "database"). */
  productFamily: string;
}

const FAMILY = /^[a-z][a-z0-9_]{0,39}$/;
const CONTROL = /\p{Cc}/u;

function normalizedEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 3 || raw.length > 254) return null;
  if (CONTROL.test(raw) || /\s/.test(raw)) return null;
  const at = raw.indexOf("@");
  if (at < 1 || at !== raw.lastIndexOf("@") || at === raw.length - 1) return null;
  const domain = raw.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  return raw.toLowerCase();
}

export async function joinVisitorWaitlist(
  tx: Tx,
  input: VisitorWaitlistJoin,
): Promise<Written<{ id: string }>> {
  const email = normalizedEmail(input?.email);
  const family = input?.productFamily;
  if (email === null || typeof family !== "string" || !FAMILY.test(family)) {
    return refused("validation");
  }
  const id = uuidv5(
    JSON.stringify([email, family, VISITOR_WAITLIST_REGION, "flag_off"]),
    VISITOR_WAITLIST_NAMESPACE,
  );
  const result = await tx.execute(sql`
    insert into waitlist_entries (id, customer_id, email, product_family, region, reason)
    values (${id}, null, ${email}, ${family}, ${VISITOR_WAITLIST_REGION}, 'flag_off')
    on conflict do nothing`);
  return result.rowCount === 1 ? created({ id }) : replayed({ id });
}
