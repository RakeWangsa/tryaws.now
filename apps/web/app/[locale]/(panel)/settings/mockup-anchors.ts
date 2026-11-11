// The cross-check of /settings/profile and /settings/security against the shared mockup (U1). Each
// row names the screen state, the mockup file it follows (read only, relative to design/mockup/)
// and the class tokens that the file carries and the rendered state must carry too.
// mockup-anchors.test.tsx turns the rows into assertions, as the wallet screens do.

export interface MockupAnchor {
  readonly state: string;
  readonly mockupFile: string;
  readonly why: string;
  readonly classes: readonly string[];
}

export const SETTINGS_ANCHORS: readonly MockupAnchor[] = [
  {
    state: "settings.profile.open",
    mockupFile: "whmcs-template/antler/clientareadetails.tpl",
    why: "Card = the white rounded block around the account details form",
    classes: ["bg-seccolorstyle", "noshadow"],
  },
  {
    state: "settings.profile.open",
    mockupFile: "whmcs-template/antler/user-profile.tpl",
    why: "the profile form: a submit button and a title in mergecolor",
    classes: ["btn", "mergecolor"],
  },
  {
    state: "settings.profile.open",
    mockupFile: "template/configurator.html",
    why: "OptionGroup (language) = the radio filter block",
    classes: ["cd-filter-block", "radio-group", "radios-filter", "radio-label", "seccolor"],
  },
  {
    state: "settings.profile.open",
    mockupFile: "template/contact.html",
    why: "Field = label and input inside a position-relative block",
    classes: ["position-relative", "mb-3", "seccolor"],
  },
  {
    state: "settings.profile.open",
    mockupFile: "template/cart.html",
    why: "the verified badge",
    classes: ["badge"],
  },
  {
    state: "settings.profile.open",
    mockupFile: "template/contact.html",
    why: "the submit button of the kit = the yellow fill button of the contact form",
    classes: ["btn-default-yellow-fill"],
  },
  {
    state: "settings.profile.closed",
    mockupFile: "template/404.html",
    why: "the not-open state: centred text",
    classes: ["text-center"],
  },
  {
    state: "settings.security.open",
    mockupFile: "whmcs-template/antler/user-password.tpl",
    why: "the password form: a submit button in a white block",
    classes: ["bg-seccolorstyle", "noshadow", "btn"],
  },
  {
    state: "settings.security.open",
    mockupFile: "template/contact.html",
    why: "Field = label and input inside a position-relative block",
    classes: ["position-relative", "mb-3", "seccolor"],
  },
  {
    state: "settings.security.closed",
    mockupFile: "template/404.html",
    why: "the not-open state: centred text",
    classes: ["text-center"],
  },
];
