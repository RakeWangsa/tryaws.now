import { commonAnchors } from "../_family/anchors.ts";
import type { MockupAnchor } from "../_family/anchors.ts";

// The cross-check of the database screens against the shared mockup (U1); the rows and the way the
// suite reads them are in _family/anchors.ts. The mockup has one database page, template/database.html
// (the public plan table: a table in tabs, badges, `title-table`); the list, the configurator and the
// detail follow the same patterns as the server screens, and add the rows that database.html carries.

export type { MockupAnchor };

export const DATABASE_ANCHORS: readonly MockupAnchor[] = [
  ...commonAnchors({
    list: "databases",
    configure: "databases_new",
    detail: "databases_detail",
  }),
  {
    state: "databases.ready",
    mockupFile: "template/database.html",
    why: "database.html shows its plans in a table with a badge for the engine and the state",
    classes: ["table", "badge"],
  },
  {
    state: "databases_new.ready",
    mockupFile: "template/database.html",
    why: "the plan block carries the title-table heading of the plan table",
    classes: ["title-table"],
  },
  {
    state: "databases_detail.ready",
    mockupFile: "template/database.html",
    why: "database.html puts its plans in tabs: tabs-header and tabs-item",
    classes: ["tabs-header", "tabs-item"],
  },
  {
    state: "databases_detail.secret",
    mockupFile: "template/checkout.html",
    why: "the Connect tab keeps the tabs and the state badge while the password is shown",
    classes: ["tabs", "tabs-item", "badge"],
  },
  {
    state: "databases_detail.pending_endpoint",
    mockupFile: "template/cart.html",
    why: "a tile without an endpoint yet keeps the card and tile classes",
    classes: ["bg-seccolorstyle", "noshadow", "wrapper", "title"],
  },
];
