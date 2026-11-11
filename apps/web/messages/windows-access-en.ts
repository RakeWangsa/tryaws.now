import type { windowsAccessBn } from "./windows-access-bn.ts";

// Typed from the Bengali tree, so a missing or extra key fails `tsc`.
type Tree<T> = { -readonly [K in keyof T]: T[K] extends string ? string : Tree<T[K]> };

export const windowsAccessEn: Tree<typeof windowsAccessBn> = {
  WindowsAccess: {
    title: "Connect with Remote Desktop (RDP)",
    intro:
      "Use an RDP client with the user name and password below to sign in to the Windows server.",
    userName: "User name",
    password: "Password",
    show: "Show password",
    working: "Getting the password…",
    warning:
      "The password is shown once, removed after 60 seconds and not kept by us. Change it at your first sign-in.",
    gone: "The password is hidden. Show it again if you need it.",
    notReady: "The password can be shown only while the server is running.",
    error: {
      unauthenticated: "Your session ended. Sign in again.",
      fresh_sign_in_required: "For your safety, sign in again, then try once more.",
      validation: "The request is not valid.",
      rate_limited: "Too many requests in a short time. Try again in a few minutes.",
      not_found: "The server was not found.",
      not_ready: "The server is not ready yet. Try again when it is running.",
      unavailable: "The password could not be fetched now. Try again in a moment.",
    },
  },
};
