// The cross-check of /support/new against the shared mockup (U1). Each row names the screen state,
// the mockup file it follows (read only, relative to design/mockup/) and the class tokens that the
// file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the rows into
// assertions, as the kyc and wallet screens do.

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const SUPPORT_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "support.form",
    mockupFile: "template/contact.html",
    why: "the ticket form: icon label, position-relative field blocks, form-control, filter block around the choices",
    classes: [
      "position-relative",
      "mb-3",
      "seccolor",
      "form-control",
      "cd-filter-block",
      "cd-filter-content",
      "fa-file-alt",
      "btn",
    ],
  },
  {
    state: "support.form",
    mockupFile: "whmcs-template/antler/supportticketsubmit-steptwo.tpl",
    why: "step two of the WHMCS ticket form: form-control fields and a button",
    classes: ["form-control", "btn", "mergecolor"],
  },
  {
    state: "support.done",
    mockupFile: "whmcs-template/antler/supportticketsubmit-confirm.tpl",
    why: "the ticket was opened: alert with the ticket reference and a button",
    classes: ["alert", "btn", "fas"],
  },
  {
    state: "support.done",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the done message: alert alert-info",
    classes: ["alert", "alert-info"],
  },
  {
    state: "support.error",
    mockupFile: "order-form/antler/error.tpl",
    why: "a refused request: alert alert-danger with a warning icon",
    classes: ["alert", "alert-danger", "fas", "fa-exclamation-triangle"],
  },
  {
    state: "support.list",
    mockupFile: "whmcs-template/antler/supportticketslist.tpl",
    why: "the list of earlier tickets: a table under a mergecolor heading",
    classes: ["table", "mergecolor"],
  },
  {
    state: "support.empty",
    mockupFile: "template/404.html",
    why: "no request yet: centred text",
    classes: ["text-center"],
  },
];
