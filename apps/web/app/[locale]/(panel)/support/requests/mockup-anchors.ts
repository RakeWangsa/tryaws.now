// The cross-check of /support/requests and /support/requests/[id] against the shared mockup (U1, WPU-Z6).
// Each row names the screen state, the mockup file it follows (read only, relative to design/mockup/) and
// the class tokens that the file carries and the rendered state must carry too. requests.test.tsx turns
// the rows into assertions, as support/new does. The WHMCS status label classes (label status status-open)
// and the ticket-reply classes are defined only in the WHMCS stylesheet, which the product does not ship,
// so they are not anchors: every rendered class must be one the theme, Bootstrap, Font Awesome or tc.css
// defines.

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const SUPPORT_REQUESTS_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "requests.list",
    mockupFile: "whmcs-template/antler/supportticketslist.tpl",
    why: "the list of tickets: a table, subjects in mergecolor",
    classes: ["table", "mergecolor"],
  },
  {
    state: "requests.empty",
    mockupFile: "whmcs-template/antler/supportticketslist.tpl",
    why: "no ticket yet: centred text",
    classes: ["text-center"],
  },
  {
    state: "thread.ready",
    mockupFile: "whmcs-template/antler/viewticket.tpl",
    why: "the thread: each message in a bg-seccolorstyle bg-white noshadow block with its date, the reply form with a pencil heading, a form-control and a button",
    classes: [
      "date",
      "mergecolor",
      "bg-seccolorstyle",
      "bg-white",
      "noshadow",
      "row",
      "form-control",
      "btn",
      "fas",
      "fa-pencil-alt",
    ],
  },
  {
    state: "thread.closed",
    mockupFile: "whmcs-template/antler/includes/alert.tpl",
    why: "a closed ticket: the alert of viewticket.tpl ($closedticket)",
    classes: ["alert"],
  },
  {
    state: "thread.closed",
    mockupFile: "whmcs-template/antler/viewticket.tpl",
    why: "a closed ticket keeps its thread and the reply form",
    classes: ["mergecolor", "form-control", "btn"],
  },
  {
    state: "thread.error",
    mockupFile: "order-form/antler/error.tpl",
    why: "a refused reply: alert alert-danger with a warning icon",
    classes: ["alert", "alert-danger", "fas", "fa-exclamation-triangle"],
  },
  {
    state: "thread.notFound",
    mockupFile: "template/404.html",
    why: "a request that is not the customer's: centred text",
    classes: ["text-center"],
  },
];
