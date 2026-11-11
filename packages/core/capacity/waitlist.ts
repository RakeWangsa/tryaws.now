import {
  adminRepos,
  type AdminActor,
  type NotifiedEntry,
  type NotifyNextInput,
  type Tx,
} from "@tc/db";
import type { Result } from "../types";

export const WAITLIST_TEMPLATE = "waitlist_capacity_available" as const;

// What the notification package gets for one taken entry. It holds no name, phone or email in data
// (R14); the recipient is the customer id or the visitor's address.
export interface WaitlistNotice {
  readonly customerId: string | null;
  readonly email: string | null;
  readonly template: typeof WAITLIST_TEMPLATE;
  readonly dedupeKey: string;
  readonly data: { readonly productFamily: string; readonly region: string };
}

// The interface to packages/notify (planned elsewhere): a caller passes a function that maps a
// notice to notify(tx, { customerId, email, template, data, dedupeKey }).
export type WaitlistNotifier = (tx: Tx, notice: WaitlistNotice) => Promise<void>;

export interface NotifyWaitlistInput extends NotifyNextInput {
  why: string;
}

// Marks the oldest open entries notified and calls the notifier once for each, in the caller's
// transaction: a throw of the notifier rolls the marks back, so no notice is lost. It writes no
// resource, no order and no reserved unit: an entry only asks to be told.
export async function notifyWaitlist(
  tx: Tx,
  actor: AdminActor,
  input: NotifyWaitlistInput,
  notifier: WaitlistNotifier,
): Promise<Result<{ notified: NotifiedEntry[] }>> {
  const done = await adminRepos(tx, actor).waitlist.notifyNext(input, input.why);
  if (!done.ok) return { ok: false, error: done.error };
  for (const entry of done.value) {
    await notifier(tx, {
      customerId: entry.customerId,
      email: entry.email,
      template: WAITLIST_TEMPLATE,
      dedupeKey: "waitlist:" + entry.id,
      data: { productFamily: entry.productFamily, region: entry.region },
    });
  }
  return { ok: true, value: { notified: done.value } };
}
