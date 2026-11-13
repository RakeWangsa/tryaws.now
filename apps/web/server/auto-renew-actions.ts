import type { CustomerLimit } from "@tc/db";
import { z } from "zod";
import { UUID, audit, frame, Refusal, type FamilyActionDeps } from "./family-actions.ts";
import type { FamilyResult } from "./family-actions.ts";
import { formObject, formText } from "./form-schema.ts";

// WPU-Z14 (owner decision of 2026-11-13: auto-renew on at purchase for every family). The auto-renew switch
// of every family with a subscription that has no switch of its own: the Billing tab of a Linux server
// (`setAutoRenewCore` of extras-actions.ts) and the domain page (`setDomainAutoRenewCore`) keep theirs.
// R9 in the frame of family-actions.ts: authenticate, authorize (the flag of the family and the ownership
// of the row, checked before the rate limit: another customer's row and a missing one are one answer and
// consume nothing, R8), validate with zod, rate limit, execute, audit. It is a switch on the customer's own
// subscription row (R1: nothing here calls AWS); setting the same value twice is the same row (R7).

/** The families whose detail page has this switch. Each one is a product flag of the same name (R12). */
export const SWITCH_FAMILIES = [
  "windows_instance",
  "disk",
  "database",
  "bucket",
  "load_balancer",
  "container_service",
  "cdn",
  "dns_zone",
] as const;
export type SwitchFamily = (typeof SWITCH_FAMILIES)[number];

/** Subscription states in which auto-renew can be turned ON; OFF is always allowed (no charge without consent). */
export const TURN_ON_STATES: readonly string[] = ["active", "grace"];

export const AUTO_RENEW_LIMIT: readonly CustomerLimit[] = [
  Object.freeze({ action: "subscription.auto_renew", limit: 30, windowSeconds: 3600 }),
];

// R9 validate: only these two fields are read (R11); the family is fixed by the Server Action, never a field.
const SwitchForm = formObject({
  resourceId: formText.pipe(z.string().regex(UUID)),
  autoRenew: formText.pipe(z.enum(["on", "off"])),
});

/** `setAutoRenew` of the detail page of `family`. The answer is a fixed key (U6). */
export async function setResourceAutoRenewCore(
  deps: FamilyActionDeps,
  family: SwitchFamily,
  raw: unknown,
): Promise<FamilyResult> {
  const parsed = SwitchForm.safeParse(raw);
  const bad: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string") bad[key] = "invalid";
    }
  }
  const resourceId = parsed.success ? parsed.data.resourceId : "";
  const on = parsed.success && parsed.data.autoRenew === "on";
  return frame(
    deps,
    {
      destructive: false,
      limits: AUTO_RENEW_LIMIT,
      ...(parsed.success ? { own: { family, id: resourceId } } : {}),
    },
    () => (parsed.success ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      if (on) {
        // Turning it on in a state where no period follows would charge for nothing (R16).
        const subscription = await repos.subscriptions.get(resourceId);
        if (subscription === null) throw new Refusal("not_found");
        if (!TURN_ON_STATES.includes(subscription.status)) throw new Refusal("not_allowed");
      }
      const set = await repos.subscriptions.setAutoRenew(resourceId, on);
      if (!set.ok) throw new Refusal("not_found");
      await audit(
        repos,
        on ? "subscription.auto_renew_on" : "subscription.auto_renew_off",
        resourceId,
      );
      return { ok: true, done: on ? "autoRenewOn" : "autoRenewOff" };
    },
  );
}
