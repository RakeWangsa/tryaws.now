import type { autoRenewBn } from "./auto-renew-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

// Namespace `AutoRenew` (WPU-Z14), English. Same keys as auto-renew-bn.ts.
export const autoRenewEn: Same<typeof autoRenewBn> = {
  AutoRenew: {
    title: "Automatic renewal",
    column: "Auto-renew",
    on: "On",
    off: "Off",
    hint: "When on, the next term is paid from your wallet when this one ends. When off, nothing is charged without your consent; the service is suspended when the term ends.",
    notNow: "Automatic renewal cannot be turned on in the current state.",
    turnOn: "Turn auto-renew on",
    turnOff: "Turn auto-renew off",
    done: {
      autoRenewOn: "Automatic renewal is on.",
      autoRenewOff: "Automatic renewal is off. The service is suspended when the term ends.",
    },
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      flag_off: "This service is not open for you yet.",
      validation: "The request is not valid. Open the page again and try once more.",
      rate_limited: "Too many requests in a short time. Please try again in a moment.",
      not_found: "This was not found.",
      not_allowed: "This cannot be done in the current state.",
      unavailable: "This could not be done now. Please try again in a moment.",
    },
  },
};
