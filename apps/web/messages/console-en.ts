import type { consoleBn } from "./console-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const consoleEn: Same<typeof consoleBn> = {
  Console: {
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      fresh_sign_in_required: "For your security, sign in again and then try once more.",
      flag_off: "This service is not open for you yet.",
      validation: "Some details are wrong. Please try again.",
      rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
      not_found: "This was not found.",
      name_mismatch: "The name does not match.",
      not_allowed:
        "This cannot be done in the current state. Try again when the earlier request has finished.",
      unavailable: "We could not finish this now. Please try again shortly.",
    },
    field: { invalid: "The value of this field is not right." },
    done: {
      settingsQueued: "The request to change the settings was taken.",
      certificateQueued:
        "The certificate request was taken. Check the validation records below in a few minutes.",
      certificateRefreshQueued: "The request to check the certificate was taken.",
      optionsQueued: "The request to change the database settings was taken.",
      versioningQueued: "The request to change versioning was taken.",
      cacheResetQueued: "The request to flush the cache was taken.",
    },
    lb: {
      settings: {
        title: "Health check and HTTPS redirect",
        intro:
          "The load balancer sends a request to this path on each server to see whether it is healthy. A server that answers 200 is healthy.",
        path: "Health check path",
        pathHint: "Start with a slash, for example /health.html. Now: {current}",
        redirect: "Redirect HTTP to HTTPS",
        keep: "Keep as it is",
        on: "Turn on",
        off: "Turn off",
        redirectHint:
          "To turn it on, a certificate must be validated and attached first. Now: {current}",
        stateOn: "on",
        stateOff: "off",
        stateUnknown: "unknown",
        button: "Save settings",
      },
      cert: {
        title: "HTTPS certificate",
        intro:
          "When you request a certificate for your domain you get a validation CNAME record. Add it to the DNS of your domain. When validation finishes, the certificate is attached to the load balancer.",
        none: "No certificate has been requested for this load balancer yet.",
        domain: "Domain",
        domainHint: "For example www.example.com. A wildcard (*) is not accepted.",
        request: "Request certificate",
        status: "Status",
        attached: "Attached to the load balancer",
        attachedYes: "Yes",
        attachedNo: "No",
        refresh: "Check status and attach",
        recordsTitle: "Validation DNS records",
        recordsCaption: "Records to add to the DNS of the domain",
        recordsEmpty: "The records have not arrived yet. Press “Check status” in a few minutes.",
        recordName: "Name",
        recordType: "Type",
        recordValue: "Value",
        statusText: {
          PENDING_VALIDATION: "Waiting for validation",
          ISSUED: "Issued",
          INACTIVE: "Inactive",
          EXPIRED: "Expired",
          VALIDATION_TIMED_OUT: "Validation timed out",
          REVOKED: "Revoked",
          FAILED: "Failed",
          UNKNOWN: "Unknown",
        },
      },
    },
    db: {
      title: "Backup window and public access",
      intro:
        "A database starts private: it cannot be reached from the internet. Automatic backups are taken every day in the window below (UTC).",
      window: "Backup window (UTC)",
      windowHint: "hh:mm-hh:mm, at least 30 minutes, for example 16:00-16:30. Now: {current}",
      windowNone: "chosen by AWS",
      maintenance: "Maintenance window (UTC)",
      maintenanceHint:
        "ddd:hh:mm-ddd:hh:mm, at least 30 minutes, for example tue:17:00-tue:17:30. It must not overlap the backup window. Now: {current}",
      publicMode: "Public access",
      keep: "Keep as it is",
      on: "Turn on",
      off: "Turn off",
      current: "Now: {current}",
      stateOn: "on",
      stateOff: "off",
      warning:
        "With public access on, the address of the database can be reached from the internet. Keep a strong password and turn it off when you are done.",
      acknowledge: "I understand the risk and want to turn public access on.",
      button: "Save settings",
    },
    bucket: {
      title: "Versioning",
      intro:
        "With versioning on, changing a file with the same name keeps the earlier version. Once turned on it cannot be removed, only suspended, and the kept versions use storage that is charged.",
      state: "Now: {current}",
      enabled: "on",
      suspended: "suspended",
      unknown: "unknown",
      enable: "Turn versioning on",
      suspend: "Suspend versioning",
    },
    cdn: {
      title: "Flush cache",
      intro:
        "After you change your website, the distribution may still hold old files in its cache. Flushing removes every cached file; the next request fetches it again.",
      button: "Flush cache",
    },
  },
};
