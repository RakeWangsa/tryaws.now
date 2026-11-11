// The cross-check of the wallet screens against the shared mockup (U1). Each row names the screen
// state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens that
// the mockup file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the
// rows into assertions: every token is in a class attribute of its mockup file, every token is in
// the rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.

export interface MockupAnchor {
  /** The screen and the state it is rendered in; the test has a renderer for each id. */
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const WALLET_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "wallet.data",
    mockupFile: "template/about.html",
    why: "StatTile = section#clientstats: balance and waiting payments",
    classes: [
      "wrapper",
      "price-container",
      "text-start",
      "bg-seccolorstyle",
      "noshadow",
      "top-content",
      "pb-5",
      "title",
      "mergecolor",
      "fromer",
      "pt-3",
      "seccolor",
      "plans",
      "badge",
      "feat",
      "bg-purple",
    ],
  },
  {
    state: "wallet.data",
    mockupFile: "template/cart.html",
    why: "DataTable = table.table.compare in div.table-responsive-lg (transactions, payments)",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "h4"],
  },
  {
    state: "wallet.data",
    mockupFile: "template/dedicated.html",
    why: "the header cell of a compare table: th.title.border-start-0",
    classes: ["title", "border-start-0"],
  },
  {
    state: "wallet.banner.checking",
    mockupFile: "order-form/antler/complete.tpl",
    why: "the waiting message after the gateway: alert alert-info",
    classes: ["alert", "alert-info"],
  },
  {
    state: "wallet.banner.cancelled",
    mockupFile: "order-form/antler/complete.tpl",
    why: "cancelled and expired: alert alert-warning",
    classes: ["alert", "alert-warning"],
  },
  {
    state: "wallet.banner.failed",
    mockupFile: "order-form/antler/error.tpl",
    why: "failed: alert alert-danger with a warning icon",
    classes: ["alert", "alert-danger", "fas", "fa-exclamation-triangle"],
  },
  {
    state: "wallet.empty",
    mockupFile: "template/404.html",
    why: "the empty state: centred text and a primary button",
    classes: ["text-center", "btn"],
  },

  // ---- /wallet/topup
  {
    state: "topup.form",
    mockupFile: "template/checkout.html",
    why: "Payment Details: table.compare.min with badge.bg-purple, the amount line b.float-end.h4.seccolor, the yellow primary button",
    classes: [
      "table-responsive-sm",
      "table",
      "compare",
      "min",
      "border-0",
      "badge",
      "bg-purple",
      "float-end",
      "h4",
      "seccolor",
      "cd-filter-block",
      "cd-filter-content",
      "btn",
      "btn-default-yellow-fill",
    ],
  },
  {
    state: "topup.form",
    mockupFile: "template/configurator.html",
    why: "option groups: cd-filter-block with a radio list (the quick amounts)",
    classes: [
      "cd-filter-block",
      "cd-filter-content",
      "radio-group",
      "radios-filter",
      "list",
      "radio-label",
      "seccolor",
      "h6",
      "mb-4",
    ],
  },
  {
    state: "topup.form",
    mockupFile: "template/payments.html",
    why: "the first sec-main pay card: badge.feat, section-heading, bullets with c-pink",
    classes: [
      "sec-main",
      "sec-bg1",
      "pay",
      "bg-seccolorstyle",
      "noshadow",
      "plans",
      "badge",
      "feat",
      "bg-purple",
      "section-heading",
      "mt-3",
      "mergecolor",
      "seccolor",
      "c-pink",
    ],
  },
  {
    state: "topup.error.unavailable",
    mockupFile: "order-form/antler/error.tpl",
    why: "the gateway is not available: alert alert-danger with the warning icon",
    classes: ["alert", "alert-danger", "fas", "fa-exclamation-triangle"],
  },
  {
    state: "topup.closed",
    mockupFile: "template/404.html",
    why: "top-up not open: centred text and a primary button",
    classes: ["text-center", "btn"],
  },

  // ---- /wallet/topup/[paymentId]
  {
    state: "status.credited",
    mockupFile: "order-form/antler/complete.tpl",
    why: "credited: section-heading, section-subheading, the card, the yellow primary button",
    classes: [
      "section-heading",
      "mergecolor",
      "border-0",
      "section-subheading",
      "text-center",
      "bg-seccolorstyle",
      "sec-bg1",
      "br-12",
      "noshadow",
      "btn",
      "btn-default-yellow-fill",
    ],
  },
  {
    state: "status.pending",
    mockupFile: "order-form/antler/complete.tpl",
    why: "pending: the same heading and card as complete.tpl, centred",
    classes: [
      "section-heading",
      "mergecolor",
      "border-0",
      "section-subheading",
      "text-center",
      "bg-seccolorstyle",
      "sec-bg1",
      "br-12",
      "noshadow",
    ],
  },
  {
    state: "status.review",
    mockupFile: "order-form/antler/complete.tpl",
    why: "review (shown as pending to the customer): the same card as complete.tpl",
    classes: [
      "section-heading",
      "mergecolor",
      "text-center",
      "bg-seccolorstyle",
      "sec-bg1",
      "br-12",
      "noshadow",
    ],
  },
  {
    state: "status.failed",
    mockupFile: "order-form/antler/error.tpl",
    why: "failed: heading, alert alert-danger with the warning icon, the yellow primary button",
    classes: [
      "section-heading",
      "mergecolor",
      "border-0",
      "section-subheading",
      "text-center",
      "alert",
      "alert-danger",
      "fas",
      "fa-exclamation-triangle",
      "bg-seccolorstyle",
      "sec-bg1",
      "br-12",
      "noshadow",
      "btn",
      "btn-default-yellow-fill",
    ],
  },
  {
    state: "status.cancelled",
    mockupFile: "order-form/antler/error.tpl",
    why: "cancelled: the same blocks as error.tpl",
    classes: [
      "section-heading",
      "section-subheading",
      "alert",
      "alert-danger",
      "fas",
      "fa-exclamation-triangle",
      "br-12",
    ],
  },
  {
    state: "status.expired",
    mockupFile: "order-form/antler/error.tpl",
    why: "expired: the same blocks as error.tpl",
    classes: [
      "section-heading",
      "section-subheading",
      "alert",
      "alert-danger",
      "fas",
      "fa-exclamation-triangle",
      "br-12",
    ],
  },
  {
    state: "status.notfound",
    mockupFile: "template/404.html",
    why: "a payment that is not found (or not the customer's): the 404 section and a primary button",
    classes: ["sec-normal", "notfound", "pt-150", "container", "text-center", "btn"],
  },
];

/**
 * Classes of the mockup files above that the screens do not carry, each with the class used instead
 * and the reason (open point 11). mockup-anchors.test.tsx checks that the class is in its mockup
 * file, that no rendered state carries it, and that the replacement is known and rendered.
 */
export const EXPLAINED_EXCEPTIONS: readonly {
  readonly cls: string;
  readonly mockupFile: string;
  readonly replacedBy: readonly string[];
  readonly why: string;
}[] = [
  {
    cls: "p-80",
    mockupFile: "order-form/antler/complete.tpl",
    replacedBy: ["p-3", "p-md-5"],
    why: "the theme's .p-80 is a fixed 80px on every side; at 360 px that leaves 200px of content (U11)",
  },
  {
    cls: "p-50",
    mockupFile: "order-form/antler/error.tpl",
    replacedBy: ["p-3", "p-md-5"],
    why: "the theme has no .p-50 (not ported); the padding of the credited card is used",
  },
  {
    cls: "error-heading",
    mockupFile: "order-form/antler/error.tpl",
    replacedBy: ["alert", "alert-danger"],
    why: "the theme has no .error-heading; the alert alone carries the icon and the state word",
  },
  {
    cls: "header-lined",
    mockupFile: "order-form/antler/error.tpl",
    replacedBy: ["text-center"],
    why: "the theme has no .header-lined (a WHMCS hook); the heading block is centred with a Bootstrap class",
  },
  {
    cls: "btn-default",
    mockupFile: "order-form/antler/complete.tpl",
    replacedBy: ["btn-default-fill"],
    why: "the kit's secondary button is btn-default-fill; the theme has no plain .btn-default",
  },
  {
    cls: "content-pay",
    mockupFile: "template/payments.html",
    replacedBy: [],
    why: "the container of the payment-method logos; no third-party logo is shipped (U3, open point 7)",
  },
];
