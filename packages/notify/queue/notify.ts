import { newUuidV7, type Tx } from "@tc/db";
import { sql } from "drizzle-orm";
import { scanSecrets } from "../text/guards";
import { channelsOf, isTemplateId, parseTemplateData } from "../templates/render";
import { DIRECT_ONLY_IDS, NotifyError, type Channel, type TemplateId } from "./types";

// Section F, kept exactly:
//   notify(tx, input: { customerId?; email?; template: TemplateId; data; dedupeKey }): Promise<void>
//   // inserts a `pending` row; `notifier` sends it after commit
// The signature is F's; the table forces one row per channel (status, attempts and dedupe_key are
// per row, and an SMS outage must not hold back the email).

export interface NotifyInput {
  readonly customerId?: string;
  readonly email?: string;
  readonly template: TemplateId;
  readonly data: Record<string, unknown>;
  readonly dedupeKey: string;
}

export interface PlannedRow {
  readonly customerId: string | null;
  readonly email: string | null;
  readonly channel: Channel;
  readonly template: TemplateId;
  readonly payload: Record<string, string | number | boolean>;
  readonly dedupeKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADDRESS = /^[^\s@<>,;"\\]+@[^\s@<>,;"\\]+\.[^\s@<>,;"\\]+$/;
// A caller key is an id, a date or a counter, never an address.
const KEY = /^[A-Za-z0-9._:-]{1,120}$/;

// The unique key of a row: the template is in it so that two messages of one event, sent with one
// caller key, do not swallow each other (R7).
export const rowKey = (template: string, dedupeKey: string, channel: Channel): string =>
  `${template}:${dedupeKey}:${channel}`;

// Everything that can be refused is refused here, before any write (R16). The errors carry a fixed
// code and at most a field name.
export function planRows(input: NotifyInput): PlannedRow[] {
  const { customerId, email, template, data, dedupeKey } = input;
  if ((DIRECT_ONLY_IDS as readonly string[]).includes(template))
    throw new NotifyError("direct_only");
  if (!isTemplateId(template)) throw new NotifyError("unknown_template");
  if (customerId !== undefined && (typeof customerId !== "string" || !UUID.test(customerId))) {
    throw new NotifyError("bad_input", "customerId");
  }
  if (
    email !== undefined &&
    (typeof email !== "string" || email.length > 254 || !ADDRESS.test(email))
  ) {
    throw new NotifyError("bad_input", "email");
  }
  if (customerId === undefined && email === undefined) throw new NotifyError("no_recipient");
  if (typeof dedupeKey !== "string" || !KEY.test(dedupeKey))
    throw new NotifyError("bad_input", "dedupeKey");

  const payload = parseTemplateData(template, data);
  // R14, 16.14: nothing that looks like a secret is queued, whoever wrote the text (an admin's KYC
  // reason, for example). The rule is not named in the error; the field is.
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value === "string" && scanSecrets(value) !== null)
      throw new NotifyError("secret_like", field);
  }

  const rows: PlannedRow[] = [];
  for (const channel of channelsOf(template, payload)) {
    // A visitor has no phone and no bell: only the email row.
    if (channel !== "email" && customerId === undefined) continue;
    rows.push({
      customerId: customerId ?? null,
      email: channel === "email" ? (email ?? null) : null,
      channel,
      template,
      payload,
      dedupeKey: rowKey(template, dedupeKey, channel),
    });
  }
  return rows;
}

// Runs in the caller's transaction (the outbox pattern): the rows exist exactly when the business
// change committed, and the notifier sends them after the commit.
//
// `ON CONFLICT DO NOTHING` has no conflict target and no RETURNING on purpose: web_rw and admin_rw
// cannot read dedupe_key, and PostgreSQL asks for SELECT on a conflict target. A replay inserts
// zero rows and does not abort the transaction (R7).
export async function notify(tx: Tx, input: NotifyInput): Promise<void> {
  const rows = planRows(input);
  if (rows.length === 0) return;
  // Raw SQL with exactly the columns web_rw, admin_rw and worker_rw may insert (migration 0006):
  // drizzle also lists the defaulted columns (status, attempts, created_at) and PostgreSQL then asks for
  // an INSERT grant on them (42501).
  const values = rows.map(
    (r) =>
      sql`(${newUuidV7()}, ${r.customerId}, ${r.email}, ${r.channel}, ${r.template}, ${JSON.stringify(r.payload)}::jsonb, ${r.dedupeKey})`,
  );
  await tx.execute(
    sql`insert into notifications (id, customer_id, email, channel, template, payload, dedupe_key)
        values ${sql.join(values, sql`, `)} on conflict do nothing`,
  );
}
