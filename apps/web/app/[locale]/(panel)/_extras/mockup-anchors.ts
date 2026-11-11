// The cross-check of the screens of WP5-T6 against the shared mockup (U1). Each row names the screen
// state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens that
// the mockup file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the
// rows into assertions, as the server screens do (servers/mockup-anchors.ts).
//
// The mockup pages that stand for the screens (found by reading design/mockup):
//   dashboard                 whmcs-template/antler/clientareahome.tpl (service tiles, rows) and
//                             template/cart.html (table.compare for the lists)
//   notifications             whmcs-template/antler/clientareaemails.tpl (a list table) and template/cart.html
//   tabs Backups, Storage,    template/checkout.html (div.tabs, price table), cart.html (table.compare),
//   Billing                   whmcs-template/antler/clientareainvoices.tpl (invoice table)
//   tab Destroy               whmcs-template/antler/clientareacancelrequest.tpl (warning, btn-danger)
//   tab Metrics               template/cart.html (card background around each chart)
//   empty / error / flag off  template/404.html (centred text and one primary button)

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

const CENTRED = "404.html: the centred text of a state (empty, error, flag off)";
const SKELETON = "skeleton blocks inside the Card of the final layout";

export const EXTRAS_ANCHORS: readonly MockupAnchor[] = [
  // /dashboard
  {
    state: "dashboard.ready",
    mockupFile: "whmcs-template/antler/clientareahome.tpl",
    why: "the client area home: rows of tiles on a card background with headings",
    classes: ["row", "mergecolor", "seccolor", "bg-seccolorstyle", "btn"],
  },
  {
    state: "dashboard.ready",
    mockupFile: "template/cart.html",
    why: "the lists are DataTable = table.table.compare in div.table-responsive-lg",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "noshadow"],
  },
  {
    state: "dashboard.empty",
    mockupFile: "whmcs-template/antler/clientareahome.tpl",
    why: "the checklist card of a new customer keeps the tile classes",
    classes: ["bg-seccolorstyle", "noshadow", "mergecolor"],
  },
  {
    state: "dashboard.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon)",
    classes: ["text-center"],
  },
  {
    state: "dashboard.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "dashboard.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  // /notifications
  {
    state: "notifications.ready",
    mockupFile: "whmcs-template/antler/clientareaemails.tpl",
    why: "a list table with one small action per row",
    classes: ["table", "btn"],
  },
  {
    state: "notifications.ready",
    mockupFile: "template/cart.html",
    why: "the table of the cart: table.table.compare in div.table-responsive-lg",
    classes: ["compare", "table-responsive-lg", "mergecolor"],
  },
  {
    state: "notifications.empty",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "notifications.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "notifications.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /servers/[id] tabs
  {
    state: "tabs.ready",
    mockupFile: "template/checkout.html",
    why: "Tabs: div.tabs with tabs-header and tabs-item; the forms use form-control and a button",
    classes: ["tabs", "tabs-header", "tabs-item", "btn"],
  },
  {
    state: "tabs.ready",
    mockupFile: "template/cart.html",
    why: "backups, disks and invoices are the cart table; the price lines are table.compare.min",
    classes: ["table", "compare", "table-responsive-lg", "title", "min"],
  },
  {
    state: "tabs.ready",
    mockupFile: "whmcs-template/antler/clientareacancelrequest.tpl",
    why: "the destroy tab is a warning with a danger button and a confirmation",
    classes: ["btn-danger"],
  },
  {
    state: "tabs.ready",
    mockupFile: "whmcs-template/antler/clientareainvoices.tpl",
    why: "the billing tab lists invoices in a table",
    classes: ["table"],
  },
  {
    state: "tabs.backups_empty",
    mockupFile: "template/404.html",
    why: CENTRED + " inside the tab",
    classes: ["text-center"],
  },
  {
    state: "tabs.storage_empty",
    mockupFile: "template/404.html",
    why: CENTRED + " inside the tab",
    classes: ["text-center"],
  },
  {
    state: "tabs.metrics_unavailable",
    mockupFile: "template/404.html",
    why: CENTRED + " (the reader is not reachable: a platform message, never AWS text)",
    classes: ["text-center"],
  },
  {
    state: "tabs.metrics_empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no data yet)",
    classes: ["text-center"],
  },
  {
    state: "tabs.billing_none",
    mockupFile: "template/cart.html",
    why: "a tab without a subscription keeps the card background",
    classes: ["bg-seccolorstyle", "noshadow"],
  },
  {
    state: "tabs.destroy_blocked",
    mockupFile: "whmcs-template/antler/clientareacancelrequest.tpl",
    why: "the destroy tab says why it cannot be done and keeps the danger button (inert)",
    classes: ["btn-danger"],
  },
  {
    state: "tabs.not_live",
    mockupFile: "template/checkout.html",
    why: "a server that is not live keeps the tabs",
    classes: ["tabs", "tabs-item"],
  },
  {
    state: "tabs.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "tabs.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
];
