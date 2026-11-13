"use server";

import { guardAction } from "../../../../server/action-deps.ts";
import { pick } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";
import {
  setResourceAutoRenewCore,
  type SwitchFamily,
} from "../../../../server/auto-renew-actions.ts";
import { familyActionDeps } from "../../../../server/family-deps.ts";

// WPU-Z14: the thin Server Actions of the auto-renew switch, one per family. The family (and with it the
// product flag) is fixed here, never a form field. Each one checks the origin, calls the core (which follows
// R9) and turns the result into a FormState with a fixed key (U6).

const run =
  (family: SwitchFamily) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    const result = await setResourceAutoRenewCore(
      familyActionDeps(family),
      family,
      pick(form, ["resourceId", "autoRenew"]),
    );
    return result.ok
      ? { done: result.done }
      : { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  };

export const setWindowsAutoRenewAction = run("windows_instance");
export const setDiskAutoRenewAction = run("disk");
export const setDatabaseAutoRenewAction = run("database");
export const setBucketAutoRenewAction = run("bucket");
export const setLoadBalancerAutoRenewAction = run("load_balancer");
export const setContainerAutoRenewAction = run("container_service");
export const setCdnAutoRenewAction = run("cdn");
export const setDnsZoneAutoRenewAction = run("dns_zone");
