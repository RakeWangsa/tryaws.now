// The cross-check of the database and load balancer screens against the shared mockup (U1). Each row
// names the screen state, the mockup file it follows (read only, relative to design/mockup/) and the
// class tokens that the mockup file carries and the rendered state must carry too. The suite in
// anchor-suite.ts turns the rows into assertions.
//
// The shared rows are the patterns the CDN and server screens follow (found by reading design/mockup):
//   list                     template/cart.html (table.compare) and whmcs-template/antler/clientareaproducts.tpl
//   configurator             template/configurator.html (section.config, aside#sidebar.ordersummary)
//   detail                   template/checkout.html (tabs) and whmcs-template/antler/clientareaproductdetails.tpl
//   empty / error / flag off template/404.html (centred text and one primary button)

export interface MockupAnchor {
  /** The screen and the state it is rendered in; the suite has a renderer for each id. */
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

const CENTRED = "404.html: the centred text of a state (empty, error, flag off)";
const SKELETON = "skeleton blocks inside the Card of the final layout";

/** Ids of the screens of one family: `list`, `configure` and `detail`, for example "databases". */
export interface ScreenIds {
  readonly list: string;
  readonly configure: string;
  readonly detail: string;
}

export function commonAnchors(ids: ScreenIds): readonly MockupAnchor[] {
  const row = (
    state: string,
    mockupFile: string,
    why: string,
    classes: readonly string[],
  ): MockupAnchor => ({ state, mockupFile, why, classes });
  return [
    // list
    row(
      `${ids.list}.ready`,
      "template/cart.html",
      "DataTable = table.table.compare in div.table-responsive-lg, state as badge",
      ["table", "compare", "table-responsive-lg", "mergecolor", "badge"],
    ),
    row(
      `${ids.list}.ready`,
      "whmcs-template/antler/clientareaproducts.tpl",
      "the service list of the client area is a table with a button",
      ["table", "btn"],
    ),
    row(`${ids.list}.empty`, "template/404.html", CENTRED + ", one primary button", [
      "text-center",
      "btn",
    ]),
    row(
      `${ids.list}.flag_off`,
      "template/404.html",
      CENTRED + " (coming soon, no button that could buy)",
      ["text-center"],
    ),
    row(`${ids.list}.loading`, "template/cart.html", SKELETON, [
      "sec-bg1",
      "bg-seccolorstyle",
      "noshadow",
    ]),
    row(`${ids.list}.error`, "template/404.html", CENTRED + ", retry button, warning icon", [
      "text-center",
      "btn",
      "fas",
    ]),
    // configurator
    row(
      `${ids.configure}.ready`,
      "template/configurator.html",
      "section.config: option groups on the left, aside#sidebar.ordersummary on the right",
      [
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
        "h6",
        "sidebar",
        "ordersummary",
        "title-table",
        "table-responsive-lg",
        "btn",
      ],
    ),
    row(
      `${ids.configure}.ready`,
      "template/checkout.html",
      "the full-width action of the summary: btn w-100",
      ["config", "w-100"],
    ),
    row(`${ids.configure}.empty`, "template/404.html", CENTRED + " (no plan for sale)", [
      "text-center",
    ]),
    row(`${ids.configure}.flag_off`, "template/404.html", CENTRED, ["text-center"]),
    row(
      `${ids.configure}.kyc_required`,
      "template/404.html",
      CENTRED + ", one button that says what to do next (16.13, not allowed)",
      ["text-center", "btn"],
    ),
    row(`${ids.configure}.loading`, "template/cart.html", SKELETON, [
      "sec-bg1",
      "bg-seccolorstyle",
      "noshadow",
    ]),
    row(`${ids.configure}.error`, "template/404.html", CENTRED + ", retry button", [
      "text-center",
      "btn",
      "fas",
    ]),
    // detail
    row(
      `${ids.detail}.ready`,
      "template/checkout.html",
      "Tabs: div.tabs with tabs-header and tabs-item",
      ["tabs", "tabs-header", "tabs-item", "badge"],
    ),
    row(
      `${ids.detail}.ready`,
      "whmcs-template/antler/clientareaproductdetails.tpl",
      "the service page: rows of two columns on a card background",
      ["row", "col-md-6", "bg-seccolorstyle", "mergecolor"],
    ),
    row(
      `${ids.detail}.stopped`,
      "template/checkout.html",
      "a stopped resource keeps the tabs and the state badge",
      ["tabs", "tabs-item", "badge"],
    ),
    row(`${ids.detail}.not_found`, "template/404.html", CENTRED + ", back to the list", [
      "text-center",
      "btn",
    ]),
    row(`${ids.detail}.loading`, "template/cart.html", SKELETON, [
      "sec-bg1",
      "bg-seccolorstyle",
      "noshadow",
    ]),
    row(`${ids.detail}.error`, "template/404.html", CENTRED + ", retry button", [
      "text-center",
      "btn",
      "fas",
    ]),
  ];
}
