// The cross-check of the public pages against the shared mockup (U1). Each row names the page state,
// the mockup file it follows (read only, relative to design/mockup/) and the class tokens that the
// mockup file carries and the rendered state must carry too. public-anchors.test.tsx turns the rows
// into assertions: every token is in a class attribute of its mockup file, every token is in the
// rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.

export interface MockupAnchor {
  /** The page and the state it is rendered in; public-states.tsx has a renderer for each id. */
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const PUBLIC_ANCHORS: readonly MockupAnchor[] = [
  // ---- / (index.html)
  {
    state: "home.data",
    mockupFile: "template/index.html",
    why: "the hero: section.top-header with the heading, the subheading and the yellow button",
    classes: [
      "top-header",
      "sec-bg6",
      "bg-colorstyle",
      "wrapper",
      "heading",
      "mergecolor",
      "pb-2",
      "subheading",
      "fw-normal",
      "text-muted",
      "btn",
      "btn-default-yellow-fill",
      "me-2",
    ],
  },
  {
    state: "home.data",
    mockupFile: "template/index.html",
    why: "the three plan cards: section.pricing.special with the PlanCard blocks",
    classes: [
      "pricing",
      "special",
      "sec-bg2",
      "wrapper",
      "top-content",
      "topradius",
      "bg-seccolorstyle",
      "title",
      "price",
      "seccolor",
      "period",
      "list-info",
      "bg-purple",
      "plans",
      "badge",
      "feat",
      "bg-dark",
      "icon-cpu",
      "icon-ram",
      "icon-drivessd",
      "icon-speed",
    ],
  },
  {
    state: "home.data",
    mockupFile: "template/index.html",
    why: "the section titles of the home page: section-heading and section-subheading",
    classes: ["section-heading", "section-subheading", "bg-seccolorstyle"],
  },
  {
    state: "home.data",
    mockupFile: "template/datacenter.html",
    why: "the closing call to action: section.getready with the support text and the button floats",
    classes: [
      "getready",
      "sec-bg1",
      "bg-seccolorstyle",
      "column-support-txt",
      "column-support-title",
      "column-support-subtitle",
      "btn-floats",
      "text-dark",
    ],
  },
  {
    state: "home.data",
    mockupFile: "template/pricing.html",
    why: "the comparison of an own AWS account with TryAWS.now: table.table.compare",
    classes: ["table", "compare", "title"],
  },
  {
    state: "home.data",
    mockupFile: "template/hosting.html",
    why: "the FAQ of the home page: accordion.faq with panel-wrap and panel-title",
    classes: ["accordion", "faq", "panel-wrap", "panel-title"],
  },

  // ---- /pricing (pricing.html)
  {
    state: "pricing.data",
    mockupFile: "template/pricing.html",
    why: "the banner and the tab section: div.top-header (the plain dark background of the hero, not the demo photo of item1, U13), section.pricing.special.motpath",
    classes: [
      "top-header",
      "heading",
      "pricing",
      "special",
      "sec-normal",
      "motpath",
      "bg-colorstyle",
      "section-heading",
      "mergecolor",
    ],
  },
  {
    state: "pricing.data",
    mockupFile: "template/pricing.html",
    why: "the comparison table: table.table.compare with th.title and the yellow button",
    classes: [
      "table",
      "compare",
      "title",
      "mergecolor",
      "border-start-0",
      "c-black",
      "btn",
      "btn-default-yellow-fill",
    ],
  },
  {
    state: "pricing.data",
    mockupFile: "template/cart.html",
    why: "the responsive wrapper of a compare table",
    classes: ["table-responsive-lg"],
  },
  {
    state: "pricing.unavailable",
    mockupFile: "template/404.html",
    why: "the empty state when prices cannot be read: centred text",
    classes: ["text-center"],
  },

  // ---- /products/cloud-servers (vps.html)
  {
    state: "cloud.data",
    mockupFile: "template/vps.html",
    why: "the banner and the plan section: div.top-header.overlay-video, section.pricing.special",
    classes: [
      "top-header",
      "overlay-video",
      "heading",
      "pricing",
      "special",
      "sec-normal",
      "pt-80",
      "pb-0",
      "bg-colorstyle",
    ],
  },
  {
    state: "cloud.data",
    mockupFile: "template/vps.html",
    why: "section#features: history-section feat01",
    classes: ["history-section", "feat01", "fw-bold", "mb-3", "mergecolor"],
  },
  {
    state: "cloud.data",
    mockupFile: "template/vps.html",
    why: "section#custom (the picker) and section#specs (the table)",
    classes: ["overlay", "section-heading", "text-white", "sec-bg1", "pb-80"],
  },

  // ---- /help (faq.html)
  {
    state: "help.data",
    mockupFile: "template/faq.html",
    why: "the banner and the FAQ section: div.top-header, section.blog.motpath",
    classes: ["top-header", "heading", "mb-0", "blog", "motpath", "pb-80", "bg-colorstyle"],
  },
  {
    state: "help.data",
    mockupFile: "template/elements.html",
    why: "the Accordion: div.accordion.faq with panel-wrap and panel-title",
    classes: ["accordion", "faq", "panel-wrap", "panel-title"],
  },

  // ---- /support (contact.html)
  {
    state: "support.data",
    mockupFile: "template/contact.html",
    why: "section#ticket: the card of the contact form, here with the ways to get support",
    classes: [
      "exapath",
      "pb-80",
      "noimage",
      "bg-seccolorstyle",
      "toppadding",
      "sec-main",
      "sec-up",
      "mb-0",
      "sec-bg1",
      "nomargin",
      "noshadow",
    ],
  },

  // ---- /legal/[doc] (legal.html)
  {
    state: "legal.terms",
    mockupFile: "template/legal.html",
    why: "the sidebar of documents: aside.sidebar with the category links",
    classes: [
      "blog",
      "motpath",
      "pb-80",
      "sidebar",
      "sec-bg1",
      "bg-seccolorstyle",
      "noshadow",
      "menu",
      "categories",
      "heading",
      "pt-2",
      "active",
      "seccolor",
    ],
  },
  {
    state: "legal.terms",
    mockupFile: "template/legal.html",
    why: "the document: wrap-blog, knowledge, wrapper with blog-info paragraphs",
    classes: [
      "pt-35",
      "wrap-blog",
      "knowledge",
      "wrapper",
      "mt-5",
      "blog-info",
      "float-end",
      "c-grey",
    ],
  },
  // WPU-Y6: the legal texts are approved (owner, 2026-11-14); the draft notice and its alert box are gone.

  // ---- system pages and the coming soon page
  {
    state: "family.soon",
    mockupFile: "template/404.html",
    why: "the coming soon page keeps the structure of 404.html: section.sec-normal.notfound",
    classes: ["sec-normal", "notfound", "pt-150", "container", "text-center"],
  },
  {
    state: "maintenance.data",
    mockupFile: "template/maintenance.html",
    why: "the maintenance page: section.sec-normal.notfound, centred text and a primary button",
    classes: ["sec-normal", "notfound", "pt-150", "container", "text-center", "btn"],
  },
];

/**
 * Classes of the mockup files above that the pages do not carry, each with the class used instead
 * and the reason. public-anchors.test.tsx checks that the class is in its mockup file and that no
 * rendered state carries it.
 */
export const EXPLAINED_EXCEPTIONS: readonly {
  readonly cls: string;
  readonly mockupFile: string;
  readonly replacedBy: readonly string[];
  readonly why: string;
}[] = [
  {
    cls: "total-grad-inverse",
    mockupFile: "template/faq.html",
    replacedBy: ["top-header"],
    why: "a decorative gradient layer of the banner; the banner keeps its own background",
  },
  {
    cls: "hideelement",
    mockupFile: "template/contact.html",
    replacedBy: [],
    why: "the decorative lines of the contact card (randomline) are not ported",
  },
];
