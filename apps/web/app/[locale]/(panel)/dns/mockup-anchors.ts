// The cross-check of the DNS screens against the shared mockup (U1). Each row names the screen state, the
// mockup file it follows (read only, relative to design/mockup/) and the class tokens that the mockup file
// carries and the rendered state must carry too. dns.test.tsx turns the rows into assertions.
//
// Found by reading design/mockup:
//   zone list, records   template/cart.html (table.table.compare in div.table-responsive-lg)
//   header cell          template/dedicated.html (th.title.border-start-0)
//   editor form          template/cart.html (input, textarea.form-control) and
//                        whmcs-template/antler/store/order.tpl (label.form-label)
//   alerts               order-form/antler/complete.tpl (alert-info, alert-danger)
//   empty / flag off     template/404.html (the centred text of a state)

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

const CENTRED = "404.html: the centred text of a state";

export const DNS_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "dns.ready",
    mockupFile: "template/cart.html",
    why: "the list of zones is the DataTable of the cart",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor"],
  },
  {
    state: "dns.ready",
    mockupFile: "template/dedicated.html",
    why: "the header cell of a compare table",
    classes: ["title", "border-start-0"],
  },
  {
    state: "dns.empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no zone yet)",
    classes: ["text-center"],
  },
  {
    state: "dns.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon, nothing that could change a record)",
    classes: ["text-center"],
  },
  {
    state: "dns.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "dns.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  {
    state: "zone.ready",
    mockupFile: "template/cart.html",
    why: "the records are a compare table; the editor fields are form controls",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "form-control", "btn-sm"],
  },
  {
    state: "zone.ready",
    mockupFile: "whmcs-template/antler/store/order.tpl",
    why: "the label of a select in a form",
    classes: ["form-label"],
  },
  {
    state: "zone.working",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the message while a change is applied: alert alert-info",
    classes: ["alert", "alert-info"],
  },
  {
    state: "zone.failed",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the message of a change that was not applied: alert alert-danger",
    classes: ["alert", "alert-danger"],
  },
  {
    state: "zone.stale",
    mockupFile: "template/404.html",
    why: CENTRED + " (the list cannot be shown)",
    classes: ["text-center"],
  },
  {
    state: "zone.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + " (not found)",
    classes: ["text-center"],
  },
  {
    state: "zone.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon)",
    classes: ["text-center"],
  },
];
