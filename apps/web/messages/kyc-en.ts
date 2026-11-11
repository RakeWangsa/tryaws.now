import type { kycBn } from "./kyc-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const kycEn: Same<typeof kycBn> = {
  Kyc: {
    meta: { title: "Identity check" },
    heading: "Identity check",
    intro:
      "Your identity check must be complete before you can buy a server. You give the details once, and our staff review them and tell you the result.",
    privacy:
      "The document number is stored encrypted, and the images are used only for the check. The web app can no longer read these images.",
    form: {
      accountTitle: "Account type",
      detailsTitle: "Identity details",
      uploadTitle: "Document images",
      type: {
        legend: "How will you use the account?",
        individual: "Individual",
        business: "Business",
      },
      document: {
        legend: "Document type",
        nid: "National ID card (NID)",
        passport: "Passport",
        driving_license: "Driving licence",
        trade_license: "Trade licence",
        tin_certificate: "TIN certificate",
      },
      number: {
        label: "Document number",
        hint: "Type it as it is printed. Spaces do not matter.",
      },
      files: {
        front: "First image or PDF",
        back: "Second image or PDF (optional, for example the back of a card)",
        hint: "JPG, PNG or PDF. Each file can be up to 5 MB.",
        tooBig: "This file is larger than 5 MB.",
        wrongType: "Use a JPG, PNG or PDF file only.",
        required: "Add at least one file.",
        failed: "The file could not be sent. Try again.",
      },
      submit: "Send for review",
      working: "Sending…",
    },
    status: {
      pending: {
        title: "Review in progress",
        body: "We have your details. We will tell you when our staff finish the review. It usually takes one working day.",
        submittedOn: "Sent on",
      },
      verified: {
        title: "Identity check complete",
        body: "You can now buy servers.",
        action: "Buy a server",
      },
      rejected: {
        title: "The check was not completed",
        body: "Read the reviewer's note, correct the details and send them again.",
        note: "Reviewer's note",
        again: "Send again",
      },
      unavailable: {
        title: "The identity check is not open yet",
        body: "This service is not switched on yet. You can give your details here once it is.",
      },
    },
    done: "Your details were sent. We will tell you when the review is finished.",
    error: {
      unauthenticated: "Your session has ended. Sign in again.",
      kyc_verified: "Your identity is already verified.",
      kyc_pending: "A check is already in progress. Wait until it finishes.",
      validation: "Some details are wrong. Correct the marked fields and try again.",
      rate_limited: "Too many requests in a short time. Wait a little and try again.",
      upload_missing: "The file was not found. Choose the file and send it again.",
      conflict: "A check has already been sent for your account.",
      forbidden: "This action could not be done.",
      unavailable: "We could not finish this now. Try again in a little while.",
    },
    field: { invalid: "The details in this field are not correct." },
  },
};
