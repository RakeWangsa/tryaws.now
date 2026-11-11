// The cross-check of /kyc against the shared mockup (U1). Each row names the screen state, the
// mockup file it follows (read only, relative to design/mockup/) and the class tokens that the file
// carries and the rendered state must carry too. mockup-anchors.test.tsx turns the rows into
// assertions, as the wallet screens do.

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const KYC_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "kyc.form",
    mockupFile: "template/configurator.html",
    why: "OptionGroup (account type and document type) = the radio filter blocks of the configurator",
    classes: [
      "cd-filter-block",
      "cd-filter-content",
      "radio-group",
      "radios-filter",
      "radio-label",
      "seccolor",
      "h6",
      "mb-4",
      "list",
    ],
  },
  {
    state: "kyc.form",
    mockupFile: "template/contact.html",
    why: "Field = label and form-control inside a position-relative block",
    classes: ["position-relative", "mb-3", "seccolor", "form-control"],
  },
  {
    state: "kyc.pending",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the waiting message: alert alert-info",
    classes: ["alert", "alert-info"],
  },
  {
    state: "kyc.verified",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the done message: alert alert-info and a primary button",
    classes: ["alert", "alert-info", "btn"],
  },
  {
    state: "kyc.rejected",
    mockupFile: "order-form/antler/error.tpl",
    why: "rejected: alert alert-danger with a warning icon",
    classes: ["alert", "alert-danger", "fas", "fa-exclamation-triangle"],
  },
  {
    state: "kyc.unavailable",
    mockupFile: "template/404.html",
    why: "the not-open state: centred text",
    classes: ["text-center"],
  },
];
