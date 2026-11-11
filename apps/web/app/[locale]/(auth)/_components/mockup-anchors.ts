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
  // ---- the five screens, in their states (Task 9)
  {
    state: "login.idle",
    mockupFile: "template/login.html",
    why: 'tab "Already Registered?": h4.m-0.mergecolor, the email and password pair, the yellow button and the forgot link on one line',
    classes: [
      "tabs-item",
      "cd-filter-block",
      "m-0",
      "mergecolor",
      "cd-filter-content",
      "row",
      "col-md-6",
      "position-relative",
      "mt-5",
      "btn",
      "btn-default-yellow-fill",
      "mt-0",
      "mb-3",
      "me-3",
      "golink",
    ],
  },
  {
    state: "login.banner.verified",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "the banner after the email code: alert alert-success",
    classes: ["alert", "alert-success"],
  },
  {
    state: "login.notAvailable",
    mockupFile: "template/404.html",
    why: "the not-available state is the empty state: text-center inside the card",
    classes: ["text-center"],
  },
  {
    state: "login.failure",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "a generic failure: alert alert-danger with an icon, a word and the reference",
    classes: ["alert", "alert-danger"],
  },
  {
    state: "login.rateLimited",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "too many attempts: alert alert-warning",
    classes: ["alert", "alert-warning"],
  },
  {
    state: "signup.idle",
    mockupFile: "template/login.html",
    why: 'tab "Create a New Account": the two group captions, row mb-5 with col-md-6 cells, the consent list and the yellow button',
    classes: [
      "seccolor",
      "mergecolor",
      "row",
      "mb-5",
      "col-md-6",
      "position-relative",
      "list",
      "checkbox-label",
      "c-grey",
      "btn",
      "btn-default-yellow-fill",
    ],
  },
  {
    state: "signup.fieldError",
    mockupFile: "template/login.html",
    why: "a field error keeps the cells of the form (col-md-6.position-relative) and adds the icon and the word",
    classes: ["row", "mb-5", "col-md-6", "position-relative"],
  },
  {
    state: "verify.email",
    mockupFile: "whmcs-template/antler/user-verify-email.tpl",
    why: "the email step: the waiting icon of the expired state (far fa-clock fa-2x text-warning) centred",
    classes: ["text-center", "far", "fa-clock", "fa-2x", "text-warning"],
  },
  {
    state: "verify.phone",
    mockupFile: "order-form/antler/viewcart.tpl",
    why: "the phone step after a send: the notice alert alert-info above the code field",
    classes: ["alert", "alert-info"],
  },
  {
    state: "forgot.idle",
    mockupFile: "whmcs-template/antler/password-reset-email-prompt.tpl",
    why: "div.text-center > p.section-subheading.mergecolor, then div.mt-50 > form > div.row > div.col-md-10",
    classes: ["text-center", "section-subheading", "mergecolor", "mt-50", "row", "col-md-10"],
  },
  {
    state: "reset.idle",
    mockupFile: "template/login.html",
    why: 'the new password pair as "Account Security": row mb-5 with col-md-6.position-relative, and the yellow button',
    classes: ["row", "mb-5", "col-md-6", "position-relative", "btn", "btn-default-yellow-fill"],
  },
];
