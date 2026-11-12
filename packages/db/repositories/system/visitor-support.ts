import { sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { Tx } from "../../client";
import { created, refused, replayed, type Written } from "../result";

// The public /support form (16.8, WPU-B6). A visitor has no customer id, so the row names the person
// by e-mail only (`support_requests.customer_id` is null; the table's recipient check allows it). Like
// visitor-waitlist.ts this is a system module, not part of customerRepos: no function of it takes a
// customer id and it reads nothing. web_rw may INSERT exactly these columns (migration 0006), so there
// is no RETURNING and no conflict target; the id is the idempotency key (R7): the same address,
// category, subject and message always give the same id, and a second call does nothing. The caller
// validates, rate limits and audits first (R9).

export const VISITOR_SUPPORT_NAMESPACE = "b2f4c6d8-3a51-4e07-9c1d-6a8e0f2b4c73";

export const VISITOR_SUPPORT_CATEGORIES = [
  "billing",
  "technical",
  "kyc",
  "domain",
  "abuse",
  "other",
] as const;

export interface VisitorSupportRequest {
  /** Any case; stored lower-case. */
  email: string;
  name: string | null;
  category: (typeof VISITOR_SUPPORT_CATEGORIES)[number];
  subject: string;
  message: string;
}

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

export async function createVisitorSupportRequest(
  tx: Tx,
  input: VisitorSupportRequest,
): Promise<Written<{ id: string }>> {
  const email = normalizedEmail(input?.email);
  const { name, category, subject, message } = input ?? {};
  if (
    email === null ||
    !(VISITOR_SUPPORT_CATEGORIES as readonly string[]).includes(category as string) ||
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > 120 ||
    typeof message !== "string" ||
    message.length < 1 ||
    message.length > 5000 ||
    (name !== null && (typeof name !== "string" || name.length < 1 || name.length > 100))
  ) {
    return refused("validation");
  }
  const id = uuidv5(JSON.stringify([email, category, subject, message]), VISITOR_SUPPORT_NAMESPACE);
  const result = await tx.execute(sql`
    insert into support_requests (id, customer_id, name, email, category, related_resource_id, subject, message)
    values (${id}, null, ${name}, ${email}, ${category}, null, ${subject}, ${message})
    on conflict do nothing`);
  return result.rowCount === 1 ? created({ id }) : replayed({ id });
}
