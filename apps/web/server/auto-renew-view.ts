import type { CustomerSession } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import type { ResourceSummary, SubscriptionRow } from "@tc/db";
import { TURN_ON_STATES, type SwitchFamily } from "./auto-renew-actions.ts";

// WPU-Z14: what the auto-renew switch of a detail page shows. Read through the customer's own
// repositories only (R8): another customer's row and a missing one answer alike (null, no switch). Only
// the switch's own facts leave this file. A read that fails is null too: the page shows no switch rather
// than a state it could not read (R16); the action checks everything again.

export interface AutoRenewView {
  resourceId: string;
  autoRenew: boolean;
  /** Turning it on is offered only while a next period can follow (active or grace). */
  canTurnOn: boolean;
}

/**
 * Pure: the switch of one row and its subscription; null when there is nothing to switch. With the flag of
 * the family off (R12) the switch is "off only": shown while auto-renew is on, so the renewals that still
 * charge can be stopped, and never offering to turn it on; none once it is off.
 */
export function autoRenewViewOf(
  family: SwitchFamily,
  row: ResourceSummary | null,
  subscription: SubscriptionRow | null,
  flagOn = true,
): AutoRenewView | null {
  if (row === null || row.family !== family || subscription === null) return null;
  if (subscription.resourceId !== row.id) return null;
  if (subscription.status === "ended" || row.state === "destroyed") return null;
  if (!flagOn && !subscription.autoRenew) return null;
  return {
    resourceId: row.id,
    autoRenew: subscription.autoRenew,
    canTurnOn: flagOn && TURN_ON_STATES.includes(subscription.status),
  };
}

/** The switch of the customer's own resource `id` of `family`; null = no switch on the page. */
export async function loadAutoRenew(
  session: CustomerSession,
  family: SwitchFamily,
  id: string,
): Promise<AutoRenewView | null> {
  try {
    return await withTx(async (tx) => {
      const repos = customerRepos(tx, session.customerId);
      const profile = await repos.profile.get();
      if (profile === null) return null;
      // R12, R16: a flag that is off or unreadable gives an "off only" switch (or none when already off).
      const flagOn = (await readFeatureFlag(tx, family, profile.market)) === true;
      const row = await repos.resources.get(id);
      if (row === null || row.family !== family) return null;
      return autoRenewViewOf(family, row, await repos.subscriptions.get(id), flagOn);
    });
  } catch {
    return null;
  }
}
