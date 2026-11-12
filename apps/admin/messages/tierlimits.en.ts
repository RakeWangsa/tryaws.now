import type { tierLimitsBn } from "./tierlimits.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const tierLimitsEn: Same<typeof tierLimitsBn> = {
  AdminTierLimits: {
    title: "Risk tier limits",
    intro:
      "Set how many resources a customer of each tier may hold, the dearest bundle, and whether Windows and containers are open. A saved value replaces the default in the code. Lowering a limit does not touch what a customer already runs; it only stops new orders past the limit. If a saved value cannot be read, orders of that tier are refused.",
    back: "Go to catalog and flags",
    market: { label: "Market", submit: "Show" },
    unavailable: {
      title: "Could not load the data",
      body: "The data is not available right now. Try again in a little while.",
    },
    result: {
      ok: "Saved.",
      replayed: "This change was already saved.",
      invalid: "The form is not correct. Check the fields and give a reason.",
      denied: "You are not allowed to do this.",
      conflict: "Another change was made at the same time. Try again.",
      not_found: "Not found.",
      rate_limited: "Too many attempts. Try again in a few minutes.",
      unavailable: "This cannot be done right now. Try again in a little while.",
    },
    tiers: { new: "New customers", trusted: "Trusted customers" },
    source: {
      stored: "Saved value",
      default: "Default value",
      invalid: "Cannot be read",
    },
    invalid:
      "The saved value cannot be read, so orders of customers in this tier are refused. Save a new value in the form below to fix it.",
    values: { yes: "Yes", no: "No" },
    editor: {
      maxInstances: "Most resources",
      maxInstancesHint:
        "Counted for each product. Servers (Linux and Windows) are counted together. 1 to 100000.",
      maxBundleUsd: "Dearest bundle, monthly price (USD)",
      maxBundleUsdHint: "The AWS price in dollars, for example 24. Not zero.",
      maxStaticIps: "Most static IPs",
      maxStaticIpsHint: "0 to 100000.",
      windows: "Windows servers open",
      containers: "Container service open",
      reason: "Reason",
      reasonHint: "It goes to the audit log.",
      save: "Save limits",
    },
    history: {
      title: "History",
      caption: "Changes of the {tier} tier",
      empty: "The limits of this tier were never changed.",
      when: "When",
      by: "By",
      change: "Resource count",
      reason: "Reason",
    },
  },
};
