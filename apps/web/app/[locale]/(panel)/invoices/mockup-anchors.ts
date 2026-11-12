// The cross-check of the invoice screens against the shared mockup (U1). Each row names the screen
// state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens that
// the mockup file carries and the rendered state must carry too. invoices.test.tsx turns the rows into
// assertions, as for the wallet screens.
//
// Found by reading design/mockup:
//   list and lines      template/cart.html (table.table.compare in div.table-responsive-lg)
//   header cell         template/dedicated.html (th.title.border-start-0)
//   empty / not found   template/404.html (the centred text of a state)

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const INVOICE_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "invoices.ready",
    mockupFile: "template/cart.html",
    why: "the list is the DataTable of the cart: table.table.compare in div.table-responsive-lg",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor"],
  },
  {
    state: "invoices.ready",
    mockupFile: "template/dedicated.html",
    why: "the header cell of a compare table",
    classes: ["title", "border-start-0"],
  },
  {
    state: "invoice.ready",
    mockupFile: "template/cart.html",
    why: "the lines of the invoice are a compare table, the total is a strong heading",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "h4"],
  },
  {
    state: "invoices.empty",
    mockupFile: "template/404.html",
    why: "the centred text of a state (no invoice yet)",
    classes: ["text-center"],
  },
  {
    state: "invoice.not_found",
    mockupFile: "template/404.html",
    why: "the centred text of a state (not found)",
    classes: ["text-center"],
  },
  {
    state: "invoice.unavailable",
    mockupFile: "template/404.html",
    why: "the centred text of a state (lines that do not add up)",
    classes: ["text-center"],
  },
  {
    state: "invoice.seller_missing",
    mockupFile: "template/404.html",
    why: "the centred text of a state (the seller details of the tax invoice are not complete)",
    classes: ["text-center"],
  },
  {
    state: "invoices.loading",
    mockupFile: "template/cart.html",
    why: "skeleton blocks inside the Card of the final layout",
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "invoices.error",
    mockupFile: "template/404.html",
    why: "the centred text of a state, retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
];
