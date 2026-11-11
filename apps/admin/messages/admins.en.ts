import type { adminsBn } from "./admins.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const adminsEn: Same<typeof adminsBn> = {
  AdminUsers: {
    result: {
      ok: "Done.",
      replayed: "This request was already done. Nothing changed.",
      invalid: "The details are not right. Check the email, the role and the reason.",
      denied: "You do not have permission for this.",
      not_found: "What you looked for was not found.",
      conflict:
        "This cannot be done in this state. The last active superadmin cannot be demoted or disabled. Reload the page and look again.",
      self: "You cannot change your own role or disable yourself. Another superadmin does it.",
      rate_limited: "Too many requests. Try again in a moment.",
      unavailable: "This cannot be done now. Nothing changed.",
      directoryFailed:
        "The admin list changed, but the sign-in service could not be told. Try again in a moment.",
    },
    title: "Admin users",
    intro:
      "Only a superadmin can open this page. Every change needs a reason, and the reason goes to the audit log.",
    reason: { label: "Reason", hint: "This reason is kept in the audit log." },
    roles: { support: "Support", finance: "Finance", ops: "Operations", superadmin: "Superadmin" },
    status: { active: "Active", disabled: "Disabled" },
    totp: { yes: "Enrolled", no: "Not enrolled", unknown: "Unknown" },
    never: "Not yet",
    unknown: "Unknown",
    you: "You",
    table: {
      caption: "Admin users",
      email: "Email",
      role: "Role",
      status: "Status",
      lastSignIn: "Last sign-in",
      totp: "TOTP",
      created: "Added",
      action: "Actions",
    },
    empty: { title: "No admins", body: "Send an invitation with the form below." },
    unavailable: {
      title: "The data could not be loaded",
      body: "The data is not available now. Try again in a moment.",
    },
    directoryOff:
      "The sign-in service is not answering, so the email, last sign-in and TOTP information cannot be shown.",
    next: "Next page",
    invite: {
      title: "Invite a new admin",
      intro:
        "The admin gets sign-in instructions by email and sets up an authenticator at the first sign-in. Admins cannot register themselves.",
      email: "Email",
      role: "Role",
      submit: "Send invitation",
    },
    change: {
      role: "New role",
      setRole: "Change role",
      disable: "Disable",
      enable: "Enable",
      resetMfa: "Reset TOTP",
      resetMfaHint: "The admin sets up the authenticator again at the next sign-in.",
      selfNote: "This is your own account. You cannot change its role or disable it.",
    },
  },
};
