import { APPROVAL_UNTIL } from "../operations/kinds";

// WPU-Y3. Owner decision of 2026-11-13 (JOURNEY, item 4): an unpaid usage charge (snapshot storage,
// static IP, transfer, other metered items) is retried every unpaid day until it is paid. There is no
// grace. The resource is suspended after 1 day and deleted at 7 days. R13 stays: until the end date
// below a deletion needs an admin; after it the deletion may run alone, but the subscription state and
// the final snapshot are still checked by the destructive guard.
//
// Everything here is pure: dates in, a decision out. The clock is injected by the caller.

const DAY_MS = 24 * 3_600_000;

export const UNPAID_SUSPEND_AFTER_DAYS = 1;
export const UNPAID_DELETE_AFTER_DAYS = 7;

/**
 * The end of the admin-approval period of R13: 2026-12-01 in Dhaka, that is 2026-12-02 00:00 +06:00.
 * One place: this is the constant `APPROVAL_UNTIL` of @tc/db, the seed of the settings row
 * `r13_approval_until`, which also decides every destroy operation at insert time. The unpaid job reads
 * the settings row (so a changed date moves both together) and falls back to approval when it cannot.
 */
export const R13_APPROVAL_UNTIL: Date = new Date(APPROVAL_UNTIL);

export type UnpaidStage =
  /** Nothing is unpaid, or the input cannot be read (R16): no action. */
  | { readonly stage: "none" }
  /** Less than 1 day since the first failed charge: only retry. */
  | { readonly stage: "retry" }
  /** From 1 day to just before 7 days: the resource is suspended; `daysLeft` is 6 down to 1. */
  | { readonly stage: "suspended"; readonly daysLeft: number; readonly deleteAt: Date }
  /** 7 days or more: the deletion is due. `approvalRequired` is R13. */
  | {
      readonly stage: "deletion";
      readonly deleteAt: Date;
      readonly approvalRequired: boolean;
    };

export interface UnpaidInput {
  /** The instant of the first failed charge of the episode; null when nothing is unpaid. */
  readonly unpaidSince: Date | null;
  readonly now: Date;
  /** The end of R13's approval period; null (unreadable) means approval is required (R16). */
  readonly approvalUntil: Date | null;
}

const valid = (d: Date | null): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

export function decideUnpaid(input: UnpaidInput): UnpaidStage {
  const { unpaidSince, now, approvalUntil } = input;
  if (!valid(unpaidSince) || !valid(now)) return { stage: "none" };
  const elapsed = now.getTime() - unpaidSince.getTime();
  const suspendAt = UNPAID_SUSPEND_AFTER_DAYS * DAY_MS;
  const deleteMs = UNPAID_DELETE_AFTER_DAYS * DAY_MS;
  const deleteAt = new Date(unpaidSince.getTime() + deleteMs);
  // A clock that is before the first failure never suspends or deletes anything.
  if (elapsed < suspendAt) return { stage: "retry" };
  if (elapsed < deleteMs) {
    return { stage: "suspended", daysLeft: Math.ceil((deleteMs - elapsed) / DAY_MS), deleteAt };
  }
  // R13: the same comparison as `requiresApproval` for a destructive kind: before the end date, or an
  // end date that cannot be read, needs an admin.
  const approvalRequired = !valid(approvalUntil) || now.getTime() < approvalUntil.getTime();
  return { stage: "deletion", deleteAt, approvalRequired };
}

/**
 * The number of whole 24-hour days since the first failed charge: 0 on the first day. A message that is
 * keyed by it goes out once for each unpaid day, and a stage never changes inside one index (the
 * stages change at 1 and 7 days).
 */
export function unpaidDayIndex(unpaidSince: Date, now: Date): number {
  if (!valid(unpaidSince) || !valid(now)) return 0;
  const elapsed = now.getTime() - unpaidSince.getTime();
  return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS);
}

/** The days before a charge on which a wallet that cannot cover it is told. */
export const WALLET_LOW_DAYS: readonly number[] = Object.freeze([3, 1]);

/**
 * True when the reminder "your wallet is low for the charge on <date>" is due: the day is one of
 * WALLET_LOW_DAYS and the balance is below the amount of the charge. An unknown or zero amount means
 * there is nothing to say. Money is bigint paisa (R4); no arithmetic.
 */
export function walletLowDue(input: {
  readonly day: number;
  readonly balanceMinor: bigint;
  readonly amountMinor: bigint | null;
}): boolean {
  if (!WALLET_LOW_DAYS.includes(input.day)) return false;
  if (input.amountMinor === null || input.amountMinor <= 0n) return false;
  return input.balanceMinor < input.amountMinor;
}
