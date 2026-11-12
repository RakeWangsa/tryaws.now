// WPU-D4 (audit C.24, spec 12): the rules by which a hosted zone that waits for delegation is checked,
// told and removed. Pure: no DNS lookup and no clock here (the job in functions/scheduler does both and
// calls these with the answers). A zone is paid for up front, so it is told twice and then removed.

const DAY_MS = 86_400_000;

/** The days after the creation of the zone on which the customer is told that it is not delegated. */
export const DELEGATION_NOTICE_DAYS = Object.freeze([7, 12] as const);
/** The day on which a zone that is still not delegated is removed (spec 12). */
export const DELEGATION_REMOVE_DAY = 14;
/** The last notice must be at least this old before the zone is removed. */
export const DELEGATION_GRACE_AFTER_NOTICE_MS = DAY_MS;

export function delegationRemovalAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + DELEGATION_REMOVE_DAY * DAY_MS);
}

const plainName = (name: string): string => name.trim().replace(/\.$/, "").toLowerCase();

/**
 * True when the name servers in the DNS answer for the customer's domain are exactly the name servers of
 * the hosted zone (a set: order, case and the trailing dot do not matter). A subset, a superset, an empty
 * answer, or a zone that has no name servers yet match nothing (R16): delegation is stated only when the
 * parent zone points at the whole set Route 53 gave us.
 */
export function nameServersMatch(found: readonly string[], zone: readonly string[]): boolean {
  if (found.length === 0 || zone.length === 0) return false;
  const wanted = new Set(zone.map(plainName));
  const seen = new Set(found.map(plainName));
  if (seen.size !== wanted.size) return false;
  for (const name of seen) if (!wanted.has(name)) return false;
  return true;
}

export type DelegationStep =
  | { readonly kind: "none" }
  /** `notice` is 1 or 2, `day` the day it stands for; `missed` is how many notices this one covers. */
  | {
      readonly kind: "notice";
      readonly notice: 1 | 2;
      readonly day: 7 | 12;
      readonly missed: number;
    }
  | { readonly kind: "remove" };

export interface DelegationStepInput {
  readonly createdAt: Date;
  readonly now: Date;
  readonly noticesSentAt: readonly Date[];
}

/**
 * What to do with one zone that is not delegated, from its age and the notices already sent.
 * After a downtime only the notice that is due now is sent (it counts the missed one). Removal needs
 * the zone to be 14 days old, both notices sent, and a full day since the last one.
 */
export function delegationStep(input: DelegationStepInput): DelegationStep {
  const created = input.createdAt.getTime();
  const now = input.now.getTime();
  if (Number.isNaN(created) || Number.isNaN(now) || now < created) return { kind: "none" };
  const age = now - created;
  const due = age >= 12 * DAY_MS ? 2 : age >= 7 * DAY_MS ? 1 : 0;
  const sent = input.noticesSentAt.length;
  if (sent < due) {
    return due === 2
      ? { kind: "notice", notice: 2, day: 12, missed: due - sent }
      : { kind: "notice", notice: 1, day: 7, missed: due - sent };
  }
  if (age >= DELEGATION_REMOVE_DAY * DAY_MS && sent >= 2) {
    const last = Math.max(...input.noticesSentAt.map((d) => d.getTime()));
    if (!Number.isNaN(last) && now - last >= DELEGATION_GRACE_AFTER_NOTICE_MS) {
      return { kind: "remove" };
    }
  }
  return { kind: "none" };
}
