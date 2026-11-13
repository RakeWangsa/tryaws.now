import type { renewalsBn } from "./renewals.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const renewalsEn: Same<typeof renewalsBn> = {
  AdminRenewals: {
    title: "Stuck domain renewals",
    link: "See the stuck domain renewals",
    intro:
      "These renewals stopped at the registry check: the registry answered ERROR, or the wait ran out. The customer's renewal charge is still taken.",
    effect:
      '"Registry confirmed not renewed" makes the provisioner ask the registry again. Only when the registry\'s final answer is not a success and the expiry date is the one before the renewal, to the millisecond, does the charge go back to the wallet (credit note). Otherwise nothing changes and the reason shows below.',
    back: "Back to payments",
    empty: {
      title: "No renewal is stuck",
      body: "No domain renewal waits for attention at the registry check.",
    },
    unavailable: {
      title: "Could not load the data",
      body: "The data is not available right now. Try again in a little while.",
    },
    result: {
      ok: "The registry check was queued. Its result shows below in a moment.",
      replayed: "This request was already done. Nothing changed.",
      invalid: "The form is not correct. Enter a reason and try again.",
      denied: "You are not allowed to do this.",
      not_found: "What you asked for was not found.",
      conflict: "The renewal is no longer stuck at the registry check. Reload the page.",
      rate_limited: "Too many requests. Try again in a few minutes.",
      unavailable: "This cannot be done right now. Nothing was changed.",
    },
    table: {
      caption: "Domain renewals stuck at the registry check",
      domain: "Domain",
      operation: "Operation",
      attempts: "Attempts",
      error: "Last error",
      created: "Created",
      lastCheck: "Last check",
      noCheck: "Not checked yet",
      unknownName: "Name not readable",
      action: "Action",
    },
    form: {
      reasonLabel: "Reason",
      reasonHint:
        "For example the registrar support case number. The reason is kept in the audit log; the customer does not see it.",
      submit: "Registry confirmed not renewed",
      pending: "A check is running. Its result shows here when it ends.",
    },
  },
};
