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
];
