// The cross-check of the container service screens against the shared mockup (U1). Each row names the
// screen state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens
// that the mockup file carries and the rendered state must carry too. container-anchors.test.tsx turns
// the rows into assertions: every token is in a class attribute of its mockup file, every token is in
// the rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.
//
// The mockup has no container service page (searched design/mockup for container and Docker: the
// hits are product names in unrelated pages), so the screens follow the pages that stand for the same
// patterns, as the server and CDN screens do:
//   service list             whmcs-template/antler/clientareaproducts.tpl and template/cart.html (table.compare)
//   configurator             template/configurator.html (section.config, aside#sidebar.ordersummary)
//   service detail           whmcs-template/antler/clientareaproductdetails.tpl and template/checkout.html (tabs)
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

export const CONTAINER_ANCHORS: readonly MockupAnchor[] = [
  // /containers
  {
    state: "containers.ready",
    mockupFile: "template/cart.html",
    why: "DataTable = table.table.compare in div.table-responsive-lg, state as badge",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "badge"],
  },
  {
    state: "containers.ready",
    mockupFile: "whmcs-template/antler/clientareaproducts.tpl",
    why: "the service list of the client area is a table with a button",
    classes: ["table", "btn"],
  },
  {
    state: "containers.empty",
    mockupFile: "template/404.html",
    why: CENTRED + ", one primary button",
    classes: ["text-center", "btn"],
  },
  {
    state: "containers.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon, no button that could buy)",
    classes: ["text-center"],
  },
  {
    state: "containers.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "containers.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  // /containers/new
  {
    state: "containers_new.ready",
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
    state: "containers_new.ready",
    mockupFile: "template/checkout.html",
    why: "the full-width action of the summary: btn w-100",
    classes: ["config", "w-100"],
  },
  {
    state: "containers_new.empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no plan for sale)",
    classes: ["text-center"],
  },
  {
    state: "containers_new.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "containers_new.kyc_required",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button that says what to do next (16.13, not allowed)",
    classes: ["text-center", "btn"],
  },
  {
    state: "containers_new.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "containers_new.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  // /containers/[id]
  {
    state: "containers_detail.ready",
    mockupFile: "template/checkout.html",
    why: "Tabs: div.tabs with tabs-header and tabs-item",
    classes: ["tabs", "tabs-header", "tabs-item", "badge"],
  },
  {
    state: "containers_detail.ready",
    mockupFile: "whmcs-template/antler/clientareaproductdetails.tpl",
    why: "the service page: rows of two columns on a card background",
    classes: ["row", "col-md-6", "bg-seccolorstyle", "mergecolor"],
  },
  {
    state: "containers_detail.deployments",
    mockupFile: "template/cart.html",
    why: "the list of deployment requests is a DataTable: table.compare in div.table-responsive-lg",
    classes: ["table", "compare", "table-responsive-lg", "bg-seccolorstyle"],
  },
  {
    state: "containers_detail.no_deployment",
    mockupFile: "template/cart.html",
    why: "a service with nothing deployed yet keeps the card and tile classes",
    classes: ["bg-seccolorstyle", "noshadow", "wrapper", "title"],
  },
  {
    state: "containers_detail.ready_pending",
    mockupFile: "template/cart.html",
    why: "the plan tab with a change set for the next renewal keeps the card and tile classes",
    classes: ["bg-seccolorstyle", "noshadow", "wrapper", "title"],
  },
  {
    state: "containers_detail.plan_failed",
    mockupFile: "template/promos.html",
    why: "a plan whose apply failed is a warning alert, text and icon, never a color alone (WPU-S3)",
    classes: ["alert", "alert-warning"],
  },
  {
    state: "containers_detail.domain_issued",
    mockupFile: "template/cart.html",
    why: "the domain tab with the validation records keeps the card and table classes",
    classes: ["bg-seccolorstyle", "noshadow", "table", "compare"],
  },
  {
    state: "containers_detail.deploy",
    mockupFile: "template/configurator.html",
    why: "the deploy form uses the option groups of the configurator: a select and a checkbox",
    classes: ["cd-filter-block", "cd-filter-content", "cd-select", "select-filter"],
  },
  {
    state: "containers_detail.deploy",
    mockupFile: "whmcs-template/antler/clientareadomaindetails.tpl",
    why: "the note about public images is an alert; the submit is btn",
    classes: ["alert", "btn"],
  },
  {
    state: "containers_detail.suspended",
    mockupFile: "template/checkout.html",
    why: "a suspended service keeps the tabs and the state badge, and the deploy form is inert",
    classes: ["tabs", "tabs-item", "badge"],
  },
  {
    state: "containers_detail.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + ", back to the list",
    classes: ["text-center", "btn"],
  },
  {
    state: "containers_detail.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "containers_detail.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
];
