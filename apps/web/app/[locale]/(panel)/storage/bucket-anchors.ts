// The cross-check of the object storage screens against the shared mockup (U1). Each row names the
// screen state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens
// that the mockup file carries and the rendered state must carry too. bucket-anchors.test.tsx turns
// the rows into assertions: every token is in a class attribute of its mockup file, every token is in
// the rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.
//
// The mockup has no object storage page (searched design/mockup for bucket, object storage and S3: the
// hits are product names in unrelated pages), so the screens follow the pages that stand for the same
// patterns, as the server and CDN screens do:
//   bucket list              whmcs-template/antler/clientareaproducts.tpl and template/cart.html (table.compare)
//   configurator             template/configurator.html (section.config, aside#sidebar.ordersummary)
//   bucket detail            whmcs-template/antler/clientareaproductdetails.tpl and template/checkout.html (tabs)
//   warnings and alerts      whmcs-template/antler/clientareadomaindetails.tpl (alert alert-warning)
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

export const BUCKET_ANCHORS: readonly MockupAnchor[] = [
  // /storage
  {
    state: "storage.ready",
    mockupFile: "template/cart.html",
    why: "DataTable = table.table.compare in div.table-responsive-lg, state as badge",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "badge"],
  },
  {
    state: "storage.ready",
    mockupFile: "whmcs-template/antler/clientareaproducts.tpl",
    why: "the service list of the client area is a table with a button",
    classes: ["table", "btn"],
  },
  {
    state: "storage.empty",
    mockupFile: "template/404.html",
    why: CENTRED + ", one primary button",
    classes: ["text-center", "btn"],
  },
  {
    state: "storage.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon, no button that could buy)",
    classes: ["text-center"],
  },
  {
    state: "storage.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "storage.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  // /storage/new
  {
    state: "storage_new.ready",
    mockupFile: "template/configurator.html",
    why: "section.config: the plan on the left, aside#sidebar.ordersummary on the right",
    classes: [
      "config",
      "row",
      "col-lg-8",
      "col-lg-4",
      "h6",
      "sidebar",
      "ordersummary",
      "title-table",
      "table-responsive-lg",
      "btn",
    ],
  },
  {
    state: "storage_new.ready",
    mockupFile: "template/checkout.html",
    why: "the full-width action of the summary: btn w-100",
    classes: ["config", "w-100"],
  },
  {
    state: "storage_new.empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no plan for sale)",
    classes: ["text-center"],
  },
  {
    state: "storage_new.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "storage_new.kyc_required",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button that says what to do next (16.13, not allowed)",
    classes: ["text-center", "btn"],
  },
  {
    state: "storage_new.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "storage_new.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /storage/[id]
  {
    state: "storage_detail.ready",
    mockupFile: "template/checkout.html",
    why: "Tabs: div.tabs with tabs-header and tabs-item",
    classes: ["tabs", "tabs-header", "tabs-item", "badge"],
  },
  {
    state: "storage_detail.ready",
    mockupFile: "whmcs-template/antler/clientareaproductdetails.tpl",
    why: "the service page: rows of two columns on a card background",
    classes: ["row", "col-md-6", "bg-seccolorstyle", "mergecolor"],
  },
  {
    state: "storage_detail.access",
    mockupFile: "whmcs-template/antler/clientareadomaindetails.tpl",
    why: "the warning of the public option is an alert; the confirmation is a form input",
    classes: ["alert", "alert-warning", "btn"],
  },
  {
    state: "storage_detail.keys",
    mockupFile: "whmcs-template/antler/clientareadomaindetails.tpl",
    why: "the secret key warning is an alert; the key buttons are btn",
    classes: ["alert", "alert-warning", "btn"],
  },
  {
    state: "storage_detail.suspended",
    mockupFile: "template/checkout.html",
    why: "a suspended bucket keeps the tabs and the state badge",
    classes: ["tabs", "tabs-item", "badge"],
  },
  {
    state: "storage_detail.destroy_open",
    mockupFile: "template/checkout.html",
    why: "the destroy tab keeps the tabs and a destructive button",
    classes: ["tabs", "tabs-item", "btn"],
  },
  {
    state: "storage_detail.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + ", back to the list",
    classes: ["text-center", "btn"],
  },
  {
    state: "storage_detail.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "storage_detail.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
];
