import { commonAnchors } from "../_family/anchors.ts";
import type { MockupAnchor } from "../_family/anchors.ts";

// The cross-check of the load balancer screens against the shared mockup (U1); the rows and the way
// the suite reads them are in _family/anchors.ts. The mockup has no load balancer page (the words
// appear only in the marketing pages index.html, datacenter.html and promos.html), so the screens
// follow the pages that stand for the same patterns, as the CDN and server screens do.

export type { MockupAnchor };

export const LOAD_BALANCER_ANCHORS: readonly MockupAnchor[] = [
  ...commonAnchors({
    list: "lb",
    configure: "lb_new",
    detail: "lb_detail",
  }),
  {
    state: "lb_new.no_servers",
    mockupFile: "template/404.html",
    why: "the centred text of a state, one button to the servers (nothing to put behind a balancer)",
    classes: ["text-center", "btn"],
  },
  {
    state: "lb_new.ready",
    mockupFile: "template/configurator.html",
    why: "the targets are a checkbox group of the option block: cd-filter-block, cd-filter-content",
    classes: ["cd-filter-block", "cd-filter-content", "list"],
  },
  {
    state: "lb_detail.targets_form",
    mockupFile: "template/configurator.html",
    why: "the change of targets is the same checkbox group inside a form",
    classes: ["cd-filter-block", "cd-filter-content", "list"],
  },
  {
    state: "lb_detail.targets_form",
    mockupFile: "template/checkout.html",
    why: "the form sits in a tab of the detail page",
    classes: ["tabs", "tabs-item", "badge"],
  },
];
