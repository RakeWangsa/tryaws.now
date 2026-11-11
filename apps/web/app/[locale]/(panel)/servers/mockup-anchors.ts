// The cross-check of the server screens against the shared mockup (U1). Each row names the screen
// state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens that
// the mockup file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the
// rows into assertions: every token is in a class attribute of its mockup file, every token is in the
// rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.
//
// The mockup pages that stand for the screens (found by reading design/mockup):
//   cloud server list        whmcs-template/antler/clientareaproducts.tpl and template/cart.html (table.compare)
//   configurator             template/configurator.html (section.config, aside#sidebar.ordersummary)
//   cart / review            template/cart.html (table.compare, aside#sidebar, Order Summary)
//   checkout                 template/checkout.html (tabs, w-100 action)
//   order complete / failed  order-form/antler/complete.tpl (alert alert-info / warning / danger)
//   service detail           whmcs-template/antler/clientareaproductdetails.tpl and template/checkout.html (tabs)
//   empty / error / flag off template/404.html (centred text and one primary button)

export interface MockupAnchor {
  /** The screen and the state it is rendered in; the test has a renderer for each id. */
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

const CENTRED = "404.html: the centred text of a state (empty, error, flag off)";

export const SERVER_ANCHORS: readonly MockupAnchor[] = [
  // /servers
  {
    state: "servers.ready",
    mockupFile: "template/cart.html",
    why: "DataTable = table.table.compare in div.table-responsive-lg, state as badge",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "badge"],
  },
  {
    state: "servers.ready",
    mockupFile: "whmcs-template/antler/clientareaproducts.tpl",
    why: "the service list of the client area is a table with a button",
    classes: ["table", "btn"],
  },
  {
    state: "servers.empty",
    mockupFile: "template/404.html",
    why: CENTRED + ", one primary button",
    classes: ["text-center", "btn"],
  },
  {
    state: "servers.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon, no button that could buy)",
    classes: ["text-center"],
  },
  {
    state: "servers.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "servers.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  // /servers/new
  {
    state: "new.ready",
    mockupFile: "template/configurator.html",
    why: "section.config: option groups on the left, aside#sidebar.ordersummary on the right",
    classes: [
      "config",
      "row",
      "col-lg-8",
      "col-lg-4",
      "cd-filter-block",
      "cd-filter-content",
      "radio-group",
      "radios-filter",
      "list",
      "radio-label",
      "cd-select",
      "select-filter",
      "h6",
      "sidebar",
      "ordersummary",
      "title-table",
      "table-responsive-lg",
      "btn",
    ],
  },
  {
    state: "new.ready",
    mockupFile: "template/checkout.html",
    why: "the full-width action of the summary: btn w-100",
    classes: ["config", "w-100"],
  },
  {
    state: "new.empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no plan for sale)",
    classes: ["text-center"],
  },
  {
    state: "new.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "new.kyc_required",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button that says what to do next (16.13, not allowed)",
    classes: ["text-center", "btn"],
  },
  {
    state: "new.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "new.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /orders/review
  {
    state: "review.ready",
    mockupFile: "template/cart.html",
    why: "table.table.compare for the order lines and aside#sidebar 'Order Summary'",
    classes: [
      "table",
      "compare",
      "table-responsive-lg",
      "col-lg-8",
      "col-lg-4",
      "sidebar",
      "ordersummary",
      "title-table",
      "checkbox-label",
      "w-100",
      "btn",
      "h4",
    ],
  },
  {
    state: "review.ready",
    mockupFile: "template/configurator.html",
    why: "the terms box is a checkbox option like the options of the configurator",
    classes: ["cd-filter-content", "checkbox-label"],
  },
  {
    state: "review.shortfall",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the shortfall and the top-up button: alert alert-warning with a button",
    classes: ["alert", "alert-warning", "btn"],
  },
  {
    state: "review.invalid",
    mockupFile: "template/404.html",
    why: CENTRED + ", back to the configuration",
    classes: ["text-center", "btn"],
  },
  {
    state: "review.expired",
    mockupFile: "template/404.html",
    why: CENTRED + ", configure again",
    classes: ["text-center", "btn"],
  },
  {
    state: "review.unavailable",
    mockupFile: "template/404.html",
    why: CENTRED + " (no draft secret: nothing can be ordered, R16)",
    classes: ["text-center"],
  },
  {
    state: "review.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "review.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /orders/[id]
  {
    state: "order.creating",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the waiting message: alert alert-info",
    classes: ["alert", "alert-info"],
  },
  {
    state: "order.ready",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the confirmation: alert alert-info and a button to the service",
    classes: ["alert", "alert-info", "btn"],
  },
  {
    state: "order.delayed",
    mockupFile: "order-form/antler/complete.tpl",
    why: "delayed, support is on it: alert alert-warning",
    classes: ["alert", "alert-warning"],
  },
  {
    state: "order.failed",
    mockupFile: "order-form/antler/complete.tpl",
    why: "failed with the automatic refund: alert alert-danger and a link to the wallet",
    classes: ["alert", "alert-danger", "btn"],
  },
  {
    state: "order.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button",
    classes: ["text-center", "btn"],
  },
  {
    state: "order.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "order.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /servers/[id]
  {
    state: "detail.ready",
    mockupFile: "template/checkout.html",
    why: "Tabs: div.tabs with tabs-header and tabs-item",
    classes: ["tabs", "tabs-header", "tabs-item", "badge"],
  },
  {
    state: "detail.ready",
    mockupFile: "whmcs-template/antler/clientareaproductdetails.tpl",
    why: "the service page: rows of two columns on a card background",
    classes: ["row", "col-md-6", "bg-seccolorstyle", "mergecolor"],
  },
  {
    state: "detail.pending_ip",
    mockupFile: "template/cart.html",
    why: "a tile without an address yet keeps the card and tile classes",
    classes: ["bg-seccolorstyle", "noshadow", "wrapper", "title"],
  },
  {
    state: "detail.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + ", back to the list",
    classes: ["text-center", "btn"],
  },
  {
    state: "detail.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "detail.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /settings/ssh-keys
  {
    state: "keys.ready",
    mockupFile: "template/cart.html",
    why: "the key list is the cart table with the small remove button (btn-sm, fa-trash-alt) and a form",
    classes: ["table", "compare", "btn-sm", "fa-trash-alt", "form-control", "h4"],
  },
  {
    state: "keys.empty",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "keys.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon)",
    classes: ["text-center"],
  },
  {
    state: "keys.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "keys.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
];
