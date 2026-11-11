// WP7-T4, spec 12: "Renewal is prepaid: reminders 60, 30 and 7 days before expiry, then RenewDomain when
// the wallet is charged." Open item 79 (default): charge and renew 35 days before expiry, and only when
// the customer turned auto-renew on; the last safe day per TLD is not decided. Pure.

export const RENEWAL_REMINDER_DAYS: readonly number[] = Object.freeze([60, 30, 7]);
export const RENEW_LEAD_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RenewalFacts {
  readonly expiresAt: Date;
  readonly now: Date;
  readonly autoRenew: boolean;
  /** The reminder days that were already sent for this expiry. */
  readonly remindersSent: readonly number[];
}

export type RenewalAction =
  | { readonly kind: "none" }
  | { readonly kind: "remind"; readonly days: number }
  | { readonly kind: "renew" }
  | { readonly kind: "expired" };

/** One action per run, the most urgent first: renew, then the nearest reminder that was not sent. */
export function domainRenewalAction(facts: RenewalFacts): RenewalAction {
  const left = (facts.expiresAt.getTime() - facts.now.getTime()) / DAY_MS;
  if (!Number.isFinite(left)) return { kind: "none" };
  if (left < 0) return { kind: "expired" };
  if (facts.autoRenew && left <= RENEW_LEAD_DAYS) return { kind: "renew" };
  // The smallest reminder day that has been reached and was not sent: a customer who joins late gets
  // the nearest reminder, not all of them.
  const due = [...RENEWAL_REMINDER_DAYS]
    .sort((a, b) => a - b)
    .filter((days) => left <= days && !facts.remindersSent.includes(days));
  const days = due[0];
  return days === undefined ? { kind: "none" } : { kind: "remind", days };
}
