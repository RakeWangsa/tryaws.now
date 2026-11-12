import type { planChangeBn } from "./planchange.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const planChangeEn: Same<typeof planChangeBn> = {
  AdminPlanChange: {
    title: "Plan change state",
    back: "Back to the operations list",
    intro:
      "A plan change of a container service or a CDN takes effect at the next renewal. This page shows the plan the resource has now, the plan that will be applied at the next renewal, and whether applying it failed.",
    unavailable: {
      title: "Could not load the data",
      body: "The data is not available right now. Try again in a little while.",
    },
    result: {
      ok: "The clear was queued.",
      replayed: "This request was already done. Nothing changed.",
      invalid: "The form is not correct. Enter a reason and try again.",
      denied: "You are not allowed to do this.",
      not_found: "What you asked for was not found.",
      conflict: "This cannot be done in the current state. Reload the page.",
      rate_limited: "Too many requests. Try again in a few minutes.",
      unavailable: "This cannot be done right now. Nothing was changed.",
    },
    facts: {
      title: "Resource",
      resource: "Resource",
      family: "Product",
      state: "State",
      region: "Region",
    },
    families: { container_service: "Container service", cdn: "CDN" },
    states: {
      creating: "Being created",
      active: "Active",
      stopped: "Stopped",
      suspended: "Suspended",
      destroyed: "Destroyed",
      failed: "Failed",
    },
    plans: {
      title: "Plans",
      applied: "Plan the resource has now",
      appliedNone: "No plan change has been applied yet. The plan from the purchase is in place.",
      pending: "Plan to be applied at the next renewal",
      pendingNone: "No plan change is scheduled.",
      unreadable: "The plan was not found in the catalog",
      offSale: "Not on sale",
      renewalNote:
        "A renewal always charges the higher price of the plan the resource has and the scheduled plan. A lower price starts one term later.",
    },
    inFlight: {
      title: "A plan apply is running",
      body: "An operation that applies a plan is queued or running now. Clearing the mark before it ends will not change the result.",
    },
    failed: {
      title: "Applying the plan failed",
      body: "The operation that applies the plan scheduled for the next renewal did not finish. The customer cannot schedule the same plan again.",
      code: "Reason of the failure",
      product: "Plan that was not applied",
      period: "Period that was charged",
      productUnknown: "Unknown (an older mark)",
      periodUnknown: "Unknown",
    },
    noMark: {
      title: "No failure mark",
      body: "This resource has no plan failure mark. There is nothing to clear.",
    },
    clear: {
      title: "Clear the failure mark",
      intro:
        "Once the mark is cleared the customer can schedule that plan again. The clear is queued and applied to the settings of the resource.",
      effect:
        "No refund or charge is made, nothing is written to the ledger, and nothing changes in AWS. Renewal pricing follows the same rule as before.",
      reasonLabel: "Reason",
      reasonHint:
        "The reason, your name and your IP address go to the audit log. The customer does not see it.",
      submit: "Clear the mark",
      pendingClear: "A clear of the mark is already queued.",
    },
    operations: {
      title: "Plan operations",
      caption: "Apply and clear operations of this resource, newest first",
      empty: "There are no operations yet.",
      kind: "Kind",
      state: "State",
      error: "Last error",
      created: "Created",
      open: "Open",
      view: "View",
    },
    link: "See the plan change state",
  },
};
