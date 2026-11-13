import type { auditBn } from "./audit.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const auditEn: Same<typeof auditBn> = {
  AdminAudit: {
    title: "Audit log",
    intro:
      "The record of every admin and system action. It is read only: nothing can be written or changed from here. Passwords, tokens, full phone numbers, emails and document numbers are masked.",
    system: "System",
    filters: {
      actor: "Done by (id)",
      actorHint: "The whole id of an admin or a customer.",
      actorType: "Actor type",
      all: "All",
      targetType: "Target type",
      targetTypeHint: "For example payment, customer, admin_user",
      targetId: "Target id",
      action: "Action",
      actionHint: "The whole name, or the start of it ending with a dot, for example payment.",
      from: "From date",
      to: "To date",
      dateHint: "Year-month-day, Dhaka time",
      submit: "Search",
      reset: "Clear filters",
    },
    actorTypes: { admin: "Admin", customer: "Customer", system: "System" },
    table: {
      caption: "Audit log, newest first",
      when: "When",
      actor: "Done by",
      action: "Action",
      target: "Target",
      ip: "IP",
      open: "Details",
    },
    empty: { title: "No records found", body: "Change the filters and search again." },
    unavailable: {
      title: "The data could not be loaded",
      body: "The data is not available now. Try again in a moment.",
    },
    next: "Next page",
    export: {
      reasonLabel: "Why do you need this export?",
      reasonHint: "Recorded in the audit log with the filter and the number of rows. Required.",
      link: "Download as CSV",
      hint: "Up to 5000 rows of the current filters. Only a superadmin can download.",
    },
    detail: {
      title: "Audit record",
      back: "Back to the audit log",
      id: "Record id",
      when: "When",
      actorType: "Actor type",
      actor: "Actor id",
      action: "Action",
      target: "Target",
      ip: "IP",
      userAgent: "Browser",
      reason: "Reason",
      noReason: "No reason recorded",
      before: "Before",
      after: "After",
      extra: "Other data",
      none: "Nothing",
      masked: "Secret data is masked.",
    },
  },
};
