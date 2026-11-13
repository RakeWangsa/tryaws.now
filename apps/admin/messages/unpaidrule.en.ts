import type { unpaidRuleBn } from "./unpaidrule.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const unpaidRuleEn: Same<typeof unpaidRuleBn> = {
  AdminUnpaidRule: {
    title: "Unpaid usage rule",
    link: "Unpaid usage rule",
    intro:
      "Switch the daily job of the unpaid usage rule on or off for each market. Every change is kept in the audit log with its reason.",
    about: {
      title: "What the rule does",
      retry:
        "When it is on, a daily job tries every unpaid usage charge again (snapshot storage, static IPs and other metered use).",
      suspend: "A resource whose charge is still unpaid after 1 day is suspended.",
      delete:
        "At day 7 the job requests the deletion of the resource; where the product has snapshots, a final snapshot is made first.",
      approval:
        "Until 2026-12-01 every deletion request still waits for an admin's approval in the operations queue.",
      off: "When it is off, the job does nothing: an unpaid charge is not tried again, and a resource that the job suspended is not started again by it, even after a top-up.",
    },
    roles:
      "Only a superadmin can turn the rule on. Ops or a superadmin can turn it off. Every admin can read this page.",
    readOnly: "Your role can read this switch but not change it.",
    market: "Market {market}",
    state: { label: "State", on: "On", off: "Off" },
    source: {
      none: "Nothing is saved for this market yet, so the job reads it as off.",
      invalid:
        "The saved value is neither on nor off, so the job reads it as off. Turn the rule off to store a clean value.",
    },
    last: {
      title: "Last change",
      none: "The audit log holds no change of this switch.",
      change: "Change",
      turnedOn: "Turned on",
      turnedOff: "Turned off",
      by: "By",
      when: "When",
      reason: "Reason",
    },
    turnOn: {
      title: "Turn the rule on",
      confirm:
        "I understand: from its next daily run the job acts on every charge that is unpaid then, counted from the first failed charge, even one from before today. A resource unpaid for 1 day or more is suspended in that run, and one unpaid for 7 days or more gets a deletion request.",
      submit: "Turn on",
    },
    turnOff: { title: "Turn the rule off", submit: "Turn off" },
    reason: { label: "Reason", hint: "It goes to the audit log." },
    empty: {
      title: "No market",
      body: "No market is set up yet, so there is no switch to show.",
    },
    unavailable: {
      title: "Could not load the rule",
      body: "The rule is not available right now. Try again in a little while.",
    },
    result: {
      ok: "Saved.",
      replayed: "The rule was already in this state. Nothing changed.",
      invalid:
        "The form is not correct. Give a reason, and tick the confirm box to turn the rule on.",
      denied: "You are not allowed to do this.",
      not_found: "Not found.",
      conflict: "Another change was made at the same time. Try again.",
      rate_limited: "Too many attempts. Try again in a few minutes.",
      unavailable: "This cannot be done right now. Nothing changed.",
    },
  },
};
