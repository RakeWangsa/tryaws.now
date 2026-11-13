// WPU-X3 (b). The pure rules of the admin action "registry confirmed not renewed" (operation kind `confirm_unrenewed`,
// run by the provisioner, functions/provisioner/confirm-unrenewed.ts). A `renew_domain` that stopped in
// needs_attention at `poll` (the registry answered ERROR, or the poll gave up) holds the customer's renewal charge:
// TiCON may have paid the registry for it. A finance admin or a superadmin asks for a fresh check; the provisioner
// reads GetOperationDetail of the saved RenewDomain operation and GetDomainDetail of the name, and this module decides.
// Only a final answer that is not SUCCESSFUL (FAILED or ERROR) with a live expiry equal, to the millisecond, to the
// expiry the row held before the renewal (`currentExpiresAt` of the renewal payload) refunds through the failed hook.
// Anything else keeps the renewal and the money as they are, and the reason is recorded (R16).

/** The four statuses of the domains port (packages/aws adapters/domains-port.ts DomainOperationStatus). */
export type RecheckStatus = "in_progress" | "successful" | "failed" | "error";

export type RenewalKeptReason =
  "registry_renewed" | "renewal_in_progress" | "expiry_changed" | "renewal_unreadable";

export type RenewalRecheck =
  | { readonly verdict: "unrenewed" }
  | { readonly verdict: "kept"; readonly reason: RenewalKeptReason };

const kept = (reason: RenewalKeptReason): RenewalRecheck => ({ verdict: "kept", reason });

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The pre-renewal expiry of a renewal payload, or null when it cannot be read exactly (R16). */
function beforeOf(payload: unknown): { year: number; at: Date } | null {
  const record = recordOf(payload);
  if (record === null) return null;
  const year = record["currentExpiryYear"];
  const text = record["currentExpiresAt"];
  if (typeof year !== "number" || !Number.isInteger(year) || typeof text !== "string") return null;
  const at = new Date(text);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== text) return null;
  // The instant and the year were written together by the renewal charge; a disagreement proves nothing.
  return at.getUTCFullYear() === year ? { year, at } : null;
}

export function renewalRecheckVerdict(input: {
  readonly status: RecheckStatus;
  /** GetDomainDetail ExpirationDate, read in the same check; null when the registry gave none. */
  readonly liveExpiresAt: Date | null;
  /** The payload of the stuck renew_domain (written by the renewal charge). */
  readonly payload: unknown;
}): RenewalRecheck {
  const before = beforeOf(input.payload);
  if (before === null) return kept("renewal_unreadable");
  switch (input.status) {
    case "successful":
      return kept("registry_renewed");
    case "in_progress":
      return kept("renewal_in_progress");
    case "failed":
    case "error":
      break;
    default:
      return kept("renewal_unreadable");
  }
  const live = input.liveExpiresAt;
  if (!(live instanceof Date) || Number.isNaN(live.getTime())) return kept("renewal_unreadable");
  if (live.getUTCFullYear() > before.year) return kept("registry_renewed");
  return live.getTime() === before.at.getTime() ? { verdict: "unrenewed" } : kept("expiry_changed");
}

const RENEWAL_POLL_STEP = "poll";

/** The target the action is for: a `renew_domain` stuck in needs_attention at `poll`. */
export function renewalConfirmable(target: {
  readonly kind: string;
  readonly state: string;
  readonly step: string | null;
}): boolean {
  return (
    target.kind === "renew_domain" &&
    target.state === "needs_attention" &&
    target.step === RENEWAL_POLL_STEP
  );
}

interface TargetFacts {
  readonly kind: string;
  readonly state: string;
  readonly step: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * Whether the target is still the one the registry check was made for: an admin's retry, a run or another failure in
 * between changes its state, step, attempts or last_error. The refund is written only when nothing moved.
 */
export function sameRenewalTarget(before: TargetFacts, now: TargetFacts): boolean {
  return (
    before.kind === now.kind &&
    before.state === now.state &&
    before.step === now.step &&
    before.attempts === now.attempts &&
    before.lastError === now.lastError
  );
}
