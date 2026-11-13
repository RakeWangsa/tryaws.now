import type { supportBn } from "./support-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const supportEn: Same<typeof supportBn> = {
  SupportForm: {
    meta: { title: "Contact support" },
    heading: "Contact support",
    intro:
      "Write down your problem or question. The MeghVPS support team answers by email to the address of your account.",
    form: {
      title: "New request",
      category: {
        legend: "Type of request",
        billing: "Billing and wallet",
        technical: "Technical problem",
        kyc: "Identity check",
        domain: "Domains and DNS",
        abuse: "Abuse report",
        other: "Something else",
      },
      related: {
        label: "Related to (optional)",
        none: "Nothing in particular",
        hint: "Pick the server or service this is about.",
      },
      subject: { label: "Subject", hint: "One line, up to 120 characters." },
      message: {
        label: "Message",
        hint: "Say what happened. Do not write passwords or secret codes.",
      },
      submit: "Send request",
      working: "Sending…",
    },
    done: {
      title: "Request sent",
      body: "We have your request. The answer comes to the email address of your account.",
      reference: "Request reference",
      again: "Write another request",
      replayed: "This request was already sent earlier. It was not added again.",
    },
    list: {
      title: "Your earlier requests",
      caption: "The list of your support requests",
      subject: "Subject",
      category: "Type",
      status: "Status",
      sentOn: "Sent on",
      empty: { title: "No requests yet", body: "Your requests show here once you send one." },
    },
    status: { open: "Open", answered: "Answered", closed: "Closed" },
    error: {
      unauthenticated: "Your session has ended. Sign in again.",
      validation: "Some details are wrong. Correct the marked fields and try again.",
      rate_limited: "Too many requests in a short time. Wait a little and try again.",
      forbidden: "This action could not be done.",
      unavailable: "We could not finish this now. Try again in a little while.",
    },
    field: { invalid: "The details in this field are not correct." },
  },
};
