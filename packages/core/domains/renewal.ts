import type { Result } from "../types";
import type { TldRow } from "./tld";

// WP7-T4, spec 12: "Renewal is prepaid: reminders 60, 30 and 7 days before expiry, then RenewDomain when
// the wallet is charged." Open item 79, decided by the owner on 2026-11-14 (WPU-Y2, delegated money rule): the
// renewal of a domain is charged, and RenewDomain sent, 30 days before the period end, which tracks the registry
// expiry; only when the customer turned auto-renew on. Pure.

export const RENEWAL_REMINDER_DAYS: readonly number[] = Object.freeze([60, 30, 7]);
export const RENEW_LEAD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN_FAMILY = "domain";

/**
 * WPU-Y2. How many days before the period end the lifecycle charges the renewal of a family: RENEW_LEAD_DAYS for a
 * domain (RenewDomain at least 30 days before the registry expiry; a short wallet has those days of retries before
 * the name could lapse), 0 for every other family (charged at the period end, section 11). The new period still
 * starts at the old period end, so the customer pays one year per year.
 */
export function renewLeadDaysOf(family: string): number {
  return family === DOMAIN_FAMILY ? RENEW_LEAD_DAYS : 0;
}

/** The lead time of every family that has one, for the candidate list of the lifecycle (lifecycleRepo). */
export const RENEW_LEAD_DAYS_BY_FAMILY: Readonly<Record<string, number>> = Object.freeze({
  [DOMAIN_FAMILY]: RENEW_LEAD_DAYS,
});

/** Plain positive decimal text with at most 4 decimals (the form of the `tlds` prices and of Consent.MaxPrice). */
const USD_TEXT = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * WPU-Y2 (owner rule a, 2026-11-14). The USD price of one year of renewal of a domain: `tlds.renewal_price_usd` of
 * the domain's TLD row (`resources.config.productId` and `.tld`, written by the order), never the registration price
 * of the purchase snapshot. The caller prices it through the normal path at the rate of the renewal day (markup,
 * fees, VAT, rounding as a purchase) and sends it as RenewDomain's Consent.MaxPrice. A row that is missing, is not
 * the domain's TLD, or has no positive renewal price in plain decimal text refuses (R16): the engine holds the
 * renewal for price_unavailable and its alarm fires. The renewal does not need the TLD to be sold for registration.
 */
export function domainRenewalUsd(
  config: Readonly<Record<string, unknown>>,
  tld: (TldRow & { readonly id: string }) | null,
): Result<string> {
  const refused: Result<string> = {
    ok: false,
    error: "internal",
    fields: { renewalPrice: "unavailable" },
  };
  const { productId, tld: name } = config;
  if (typeof productId !== "string" || !UUID.test(productId) || typeof name !== "string") {
    return refused;
  }
  if (tld === null || tld.id !== productId || tld.tld !== name) return refused;
  const price = tld.renewalPriceUsd;
  if (price === null || !USD_TEXT.test(price) || !/[1-9]/.test(price)) return refused;
  return { ok: true, value: price };
}

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
