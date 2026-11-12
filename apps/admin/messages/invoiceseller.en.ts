import type { invoiceSellerBn } from "./invoiceseller.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const invoiceSellerEn: Same<typeof invoiceSellerBn> = {
  AdminInvoiceSeller: {
    title: "Seller details (tax invoice)",
    intro:
      "Every customer invoice is printed in the Mushak-6.3 (Tax Invoice) form of the National Board of Revenue. The form needs the seller's legal name, the 13-digit BIN, the address, and the name and designation of the authorised signatory. Enter the values here; nothing is filled in beforehand.",
    back: "Back to pricing",
    market: { label: "Market", submit: "Show" },
    unavailable: {
      title: "Could not load the data",
      body: "The data is not available right now. Try again in a little while.",
    },
    result: {
      ok: "Saved.",
      replayed: "These details were already saved.",
      invalid: "The form is not correct. Check the fields and give a reason.",
      denied: "You are not allowed to do this.",
      conflict: "Another change was made at the same time. Try again.",
      not_found: "Not found.",
      rate_limited: "Too many attempts. Try again in a few minutes.",
      unavailable: "This cannot be done right now. Try again in a little while.",
    },
    status: {
      title: "Current state",
      missing: "Not entered",
      invalid: "Cannot be read",
      ready: "Complete",
      version: "Version {version}",
    },
    notice: {
      missing:
        "The seller details are not entered. Until they are, no invoice is issued or printed in this market. Fill in every field of the form below.",
      invalid:
        "The saved details cannot be read or are incomplete. Until they are fixed, no invoice is issued or printed.",
    },
    current: { title: "Saved details", empty: "-" },
    form: {
      legalNameBn: "Legal name (Bengali)",
      legalNameEn: "Legal name (English)",
      bin: "BIN",
      binHint: "13 Latin digits, for example 1234567890123.",
      addressBn: "Address (Bengali)",
      addressEn: "Address (English)",
      vatCircle: "VAT circle / commissionerate (optional)",
      signatoryName: "Signatory name",
      signatoryDesignation: "Signatory designation",
      phone: "Phone (optional)",
      email: "Email (optional)",
      reason: "Reason",
      reasonHint: "It goes to the audit log.",
      save: "Save seller details",
    },
    history: {
      title: "History",
      caption: "Changes of the seller details",
      empty: "The seller details were never saved.",
      when: "When",
      by: "By",
      change: "Fields changed",
      reason: "Reason",
    },
  },
};
