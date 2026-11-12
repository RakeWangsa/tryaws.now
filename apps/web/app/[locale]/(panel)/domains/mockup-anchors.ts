// The cross-check of the domain screens against the shared mockup (U1). Each row names the screen state,
// the mockup file it follows (read only, relative to design/mockup/) and the class tokens that the
// mockup file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the rows
// into assertions (same method as the CDN screens).
//
// Found by reading design/mockup:
//   search and TLD table     template/domains.html (table.compare, input) and the WHMCS
//                            clientareadomains.tpl (the list of domains with a state label)
//   registration + contact   template/configurator.html (section.config, aside.ordersummary) and
//                            whmcs-template/antler/clientareadomaincontactinfo.tpl for the wording
//   detail                   whmcs-template/antler/clientareadomaindetails.tpl (rows on a card)
//   empty / error / flag off template/404.html

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

const CENTRED = "404.html: the centred text of a state (empty, error, flag off)";
const SKELETON = "skeleton blocks inside the Card of the final layout";

export const DOMAIN_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "domains.ready",
    mockupFile: "template/domains.html",
    why: "the TLD price table is table.table.compare in div.table-responsive-lg; buttons and badges",
    classes: ["table", "compare", "table-responsive-lg", "mergecolor", "badge", "btn"],
  },
  {
    state: "domains.ready",
    mockupFile: "whmcs-template/antler/clientareadomains.tpl",
    why: "the client area list of domains is a table with a button",
    classes: ["table", "btn"],
  },
  {
    state: "domains.review",
    mockupFile: "template/domains.html",
    why: "a TLD that needs review keeps the price table",
    classes: ["table", "compare"],
  },
  {
    state: "domains.taken",
    mockupFile: "template/domains.html",
    why: "the answer of the search sits above the table",
    classes: ["mergecolor", "table"],
  },
  {
    state: "domains.search_unavailable",
    mockupFile: "template/domains.html",
    why: "the search box stays; the table stays",
    classes: ["seccolor", "table"],
  },
  {
    state: "domains.empty",
    mockupFile: "template/404.html",
    why: CENTRED + " (no domain yet)",
    classes: ["text-center"],
  },
  {
    state: "domains.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED + " (coming soon, no button that could buy)",
    classes: ["text-center"],
  },
  {
    state: "domains.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "domains.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button, warning icon",
    classes: ["text-center", "btn", "fas"],
  },
  {
    state: "domain_new.ready",
    mockupFile: "template/configurator.html",
    why: "section.config: the contact form on the left, aside#sidebar.ordersummary on the right",
    classes: [
      "config",
      "row",
      "col-lg-8",
      "col-lg-4",
      "cd-filter-block",
      "cd-filter-content",
      "radio-group",
      "sidebar",
      "ordersummary",
      "title-table",
      "table-responsive-lg",
      "btn",
    ],
  },
  {
    state: "domain_new.ready",
    mockupFile: "template/checkout.html",
    why: "the full-width action of the summary: btn w-100",
    classes: ["config", "w-100"],
  },
  {
    state: "domain_new.review",
    mockupFile: "template/configurator.html",
    why: "a review TLD shows the approval row in the same summary",
    classes: ["ordersummary", "title-table"],
  },
  {
    state: "domain_new.invalid",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button back to the search",
    classes: ["text-center", "btn"],
  },
  {
    state: "domain_new.flag_off",
    mockupFile: "template/404.html",
    why: CENTRED,
    classes: ["text-center"],
  },
  {
    state: "domain_new.kyc_required",
    mockupFile: "template/404.html",
    why: CENTRED + ", one button that says what to do next (16.13, not allowed)",
    classes: ["text-center", "btn"],
  },
  {
    state: "domain_new.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "domain_new.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
  {
    state: "domain_detail.ready",
    mockupFile: "whmcs-template/antler/clientareadomaindetails.tpl",
    why: "the domain page: cards with rows of two columns",
    classes: ["row", "btn"],
  },
  {
    state: "domain_detail.ready",
    mockupFile: "template/cart.html",
    why: "cards on the card background with a badge for the state",
    classes: ["bg-seccolorstyle", "noshadow", "badge", "mergecolor"],
  },
  {
    state: "domain_detail.verified",
    mockupFile: "template/cart.html",
    why: "a verified domain keeps the cards and the state badge",
    classes: ["bg-seccolorstyle", "badge"],
  },
  {
    state: "domain_detail.not_found",
    mockupFile: "template/404.html",
    why: CENTRED + ", back to the list",
    classes: ["text-center", "btn"],
  },
  {
    state: "domain_detail.loading",
    mockupFile: "template/cart.html",
    why: SKELETON,
    classes: ["sec-bg1", "bg-seccolorstyle", "noshadow"],
  },
  {
    state: "domain_detail.error",
    mockupFile: "template/404.html",
    why: CENTRED + ", retry button",
    classes: ["text-center", "btn", "fas"],
  },
];
