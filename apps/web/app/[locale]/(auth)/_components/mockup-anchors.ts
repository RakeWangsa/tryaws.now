// The cross-check of the sign-in screens against the shared mockup (U1). Each row names a screen
// state, the mockup file it follows (read only, relative to design/mockup/) and the class tokens that
// the mockup file carries and the rendered state must carry too. mockup-anchors.test.tsx turns the
// rows into assertions: every token is in a class attribute of its mockup file, every token is in the
// rendered HTML of its state in bn and en, and every class of the rendered HTML is one that the
// theme, Bootstrap, Font Awesome or tc.css defines.
//
// Left out on purpose (the plan's mockup table): the `comments-form` form class of login.html (no
// stylesheet defines it), "Remember Me" (16.9), billing address, state, postcode, country and the
// security question (16.9), the spinner, the close button, jQuery, the captcha include, the strength
// meter and the "cancel" reset button of the WHMCS templates (no script, U2).

export interface MockupAnchor {
  /** The screen and the state it is rendered in; the test has a renderer for each id. */
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const AUTH_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "auth.card",
    mockupFile: "template/login.html",
    why: "the card head: random line, h2.mergecolor, p.mb-5.mergecolor",
    classes: ["randomline", "bigline", "smallline", "mergecolor", "mb-5"],
  },
  {
    state: "auth.tabs.login",
    mockupFile: "template/login.html",
    why: "div.tabs-header.btn-select-customer > ul.btn-group.d-block > li.btn.btn-secondary.active.mb-2 (links instead of script tabs, open point 23)",
    classes: [
      "tabs-header",
      "btn-select-customer",
      "btn-group",
      "d-block",
      "btn",
      "btn-secondary",
      "active",
      "mb-2",
    ],
  },
  {
    state: "auth.tabs.signup",
    mockupFile: "template/login.html",
    why: "the second tab is the active one on /signup",
    classes: ["tabs-header", "btn-group", "btn", "btn-secondary", "active"],
  },
  {
    state: "auth.body",
    mockupFile: "template/login.html",
    why: "the body of a tab: div.row > col-sm-12 > div.table.tabs-item.active > div.cd-filter-block.mb-0 > h4.m-0.mergecolor + div.cd-filter-content",
    classes: [
      "row",
      "col-sm-12",
      "table",
      "tabs-item",
      "active",
      "cd-filter-block",
      "mb-0",
      "m-0",
      "mergecolor",
      "cd-filter-content",
    ],
  },
  {
    state: "auth.fields",
    mockupFile: "template/login.html",
    why: "field pairs (col-md-6.position-relative), the label and the yellow submit button",
    classes: [
      "row",
      "col-md-6",
      "position-relative",
      "mb-5",
      "btn",
      "btn-default-yellow-fill",
      "seccolor",
    ],
  },
  {
    state: "auth.consent",
    mockupFile: "template/login.html",
    why: "the consent boxes take the markup of the Remember Me box: ul.list > li > input + label.checkbox-label.c-grey.seccolor (the unstyled hook class `filter` is left out)",
    classes: ["list", "checkbox-label", "c-grey", "seccolor", "golink"],
  },
  {
    state: "auth.alert.danger",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "an error: alert alert-danger",
    classes: ["alert", "alert-danger"],
  },
  {
    state: "auth.alert.warning",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "a limit or an outage: alert alert-warning",
    classes: ["alert", "alert-warning"],
  },
  {
    state: "auth.alert.info",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "a plain notice: alert alert-info",
    classes: ["alert", "alert-info"],
  },
  {
    state: "auth.alert.success",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "a success banner after verify or reset: alert alert-success",
    classes: ["alert", "alert-success"],
  },
];
