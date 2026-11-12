// WPU-N1: the customer line when a plan change or a renewal step waits for the resource (audit 2, D.13).
// Pure. A stopped resource waits until the customer starts it; one that is still being created, or has
// a change in flight, waits until that is done. Any other state, and a subscription that is not
// running, says nothing (no guess, R16). The line promises nothing about money.

export type RenewalWait = "stopped" | "busy" | null;

export function renewalWaitOf(
  subscriptionStatus: string | null,
  resourceState: string,
  hasActiveOperation: boolean,
): RenewalWait {
  if (subscriptionStatus !== "active" && subscriptionStatus !== "grace") return null;
  if (resourceState === "stopped") return "stopped";
  if (resourceState === "creating" || hasActiveOperation) return "busy";
  return null;
}
