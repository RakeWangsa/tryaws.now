// The cross-check of the CDN screens against the shared mockup (U1). Each row names the screen state,
// the mockup file it follows (read only, relative to design/mockup/) and the class tokens that the
// mockup file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the rows
// into assertions: every token is in a class attribute of its mockup file, every token is in the
// rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.
//
// The mockup has no CDN page (the only CDN text is in documentation/faq.html), so the screens follow
// the pages that stand for the same patterns, as the server screens do (found by reading design/mockup):
//   CDN list                 whmcs-template/antler/clientareaproducts.tpl and template/cart.html (table.compare)
//   configurator             template/configurator.html (section.config, aside#sidebar.ordersummary)
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
const SKELETON = "skeleton blocks inside the Card of the final layout";

export const CDN_ANCHORS: readonly MockupAnchor[] = [
  // /cdn
  {
    state: "cdn.ready",
    mockupFile: "template/cart.html",
    why: "DataTable = table.table.compare in div.table-responsive-lg, state as badge",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "badge"],
  },
  {
    state: "cdn.ready",
    mockupFile: "whmcs-template/antler/clientareaproducts.tpl",
    why: "the service list of the client area is a table with a button",
    classes: ["table", "btn"],
  },
  {
    state: "cdn.empty",
    mockupFile: "template/404.html",
    why: CENTRED + ", one primary button",
    classes: ["text-center", "btn"],
  },
  {
    state: "cdn.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon, no button that could buy)",
    classes: ["text-center"],
  },
  {
    state: "cdn.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "cdn.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  // /cdn/new
  {
    state: "cdn_new.ready",
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
    state: "cdn_new.ready",
    mockupFile: "template/checkout.html",
    why: "the full-width action of the summary: btn w-100",
    classes: ["config", "w-100"],
  },
  {
    state: "cdn_new.empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no plan for sale)",
    classes: ["text-center"],
  },
  {
    state: "cdn_new.no_origin",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button to the servers (nothing to put a CDN in front of)",
    classes: ["text-center", "btn"],
  },
  {
    state: "cdn_new.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "cdn_new.kyc_required",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button that says what to do next (16.13, not allowed)",
    classes: ["text-center", "btn"],
  },
  {
    state: "cdn_new.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "cdn_new.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /cdn/[id]
  {
    state: "cdn_detail.ready",
    mockupFile: "template/checkout.html",
    why: "Tabs: div.tabs with tabs-header and tabs-item",
    classes: ["tabs", "tabs-header", "tabs-item", "badge"],
  },
  {
    state: "cdn_detail.ready",
    mockupFile: "whmcs-template/antler/clientareaproductdetails.tpl",
    why: "the service page: rows of two columns on a card background",
    classes: ["row", "col-md-6", "bg-seccolorstyle", "mergecolor"],
  },
  {
    state: "cdn_detail.pending_domain",
    mockupFile: "template/cart.html",
    why: "a tile without a domain yet keeps the card and tile classes",
    classes: ["bg-seccolorstyle", "noshadow", "wrapper", "title"],
  },
  {
    state: "cdn_detail.stopped",
    mockupFile: "template/checkout.html",
    why: "a stopped distribution keeps the tabs and the state badge",
    classes: ["tabs", "tabs-item", "badge"],
  },
  {
    state: "cdn_detail.pending_plan",
    mockupFile: "template/checkout.html",
    why: "the plan tab keeps the tabs and the form classes",
    classes: ["tabs", "tabs-item"],
  },
  {
    state: "cdn_detail.plan_failed",
    mockupFile: "template/promos.html",
    why: "a plan whose apply failed is a warning alert, text and icon, never a color alone (WPU-S3)",
    classes: ["alert", "alert-warning"],
  },
  {
    state: "cdn_detail.cache_saved",
    mockupFile: "template/checkout.html",
    why: "the cache tab keeps the tabs and the form classes",
    classes: ["tabs", "tabs-item"],
  },
  {
    state: "cdn_detail.domain_pending",
    mockupFile: "template/checkout.html",
    why: "the domain tab keeps the tabs and the table classes",
    classes: ["tabs", "tabs-item", "compare"],
  },
  {
    state: "cdn_detail.no_other_origin",
    mockupFile: "template/checkout.html",
    why: "the origin tab with nothing to choose keeps the tabs",
    classes: ["tabs", "tabs-item"],
  },
  {
    state: "cdn_detail.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + ", back to the list",
    classes: ["text-center", "btn"],
  },
  {
    state: "cdn_detail.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "cdn_detail.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
];
