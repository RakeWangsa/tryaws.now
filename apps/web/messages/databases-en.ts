import type { databasesBn } from "./databases-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const databasesEn: Same<typeof databasesBn> = {
  Databases: {
    meta: { title: "Databases" },
    heading: "Databases",
    awsNote:
      "Every database is an Amazon Lightsail managed database running in the AWS Region you choose. A database starts private.",
    flagOff: {
      title: "Databases are coming soon",
      body: "This service is not open in your market yet. You will be able to buy it here once it opens.",
    },
    kycRequired: {
      title: "Verify your identity first",
      body: "Identity verification must be complete before you can buy a database. Come back here when it is done.",
      action: "Write to support",
    },
    state: {
      creating: "Creating",
      active: "Running",
      stopped: "Stopped",
      suspended: "Suspended",
      destroyed: "Deleted",
      failed: "Problem",
    },
    engine: {
      mysql: "MySQL",
      postgres: "PostgreSQL",
    },
    spec: {
      engine: "Engine: {engine}",
      engineVersion: "Engine: {engine} {version}",
    },
    list: {
      caption: "Your databases",
      name: "Name",
      engine: "Engine",
      location: "Location",
      endpoint: "Endpoint",
      state: "State",
      none: "—",
      create: "New database",
      empty: {
        title: "No database yet",
        body: "Get a managed database for your app. We look after backups and updates.",
      },
    },
    new: {
      meta: { title: "New database" },
      heading: "New database",
      intro:
        "Choose a location and a plan. The plan sets the engine, the version and the size. The database is created private, and you can ask to see its master password once after it is created.",
      step: {
        location: "1. Location",
        plan: "2. Plan (engine, version and size)",
        name: "3. Name",
      },
      locationHint: "A database in the Region closest to your servers connects faster.",
      planLegend: "Choose a plan",
      nameHint: "For you only. Letters, digits, spaces, dots, underscores and hyphens.",
      namePlaceholder: "For example: my-app-database",
      noPlans: {
        title: "No plan is for sale right now",
        body: "Please look again in a little while.",
      },
      summary: {
        title: "Order summary",
        engine: "Engine",
        location: "Location",
        access: "Access",
        accessValue: "Private",
        term: "Term",
        termValue: "30 days",
        price: "Total price",
      },
      submit: "Go to review",
    },
    detail: {
      meta: { title: "Database details" },
      back: "All databases",
      tabsLabel: "Database sections",
      notFound: {
        title: "Database not found",
        body: "This database does not exist, or it is not in your account.",
      },
      header: { aws: "Amazon Lightsail managed database" },
      tab: {
        overview: "Overview",
        access: "Connect",
        backups: "Backups",
        metrics: "Metrics",
        settings: "Settings",
        parameters: "Parameters",
        destroy: "Delete",
      },
      overview: {
        engine: "Engine",
        location: "Location",
        endpoint: "Endpoint",
        endpointHint: "Connect your app with this address and the port.",
        endpointPending: "The endpoint will show here once the database is created.",
        port: "Port",
        portPending: "Shown after it is created",
        access: "Access",
        accessValue: "Private",
        created: "Created",
      },
      access: {
        title: "Connect to the database",
        intro:
          "Connect to the endpoint with the user name and the master password. We do not keep the password, so ask for it here when you need it.",
        warning:
          "The password is shown once, removed after 60 seconds and not kept by us. Do not send it to anyone.",
        userName: "User name",
        password: "Password",
        show: "Show password",
        working: "Getting the password…",
        gone: "The password is hidden. Show it again if you need it.",
        notReady: "The password can be shown only while the database is running.",
        error: {
          unauthenticated: "Your session ended. Sign in again.",
          fresh_sign_in_required: "For your safety, sign in again, then try once more.",
          validation: "The request is not valid.",
          rate_limited: "Too many requests in a short time. Try again in a few minutes.",
          not_found: "The database was not found.",
          not_ready: "The database is not ready yet. Try again when it is running.",
          unavailable: "The password could not be fetched now. Try again in a moment.",
        },
        publicMode: {
          title: "Public access",
          off: "This database is private: it cannot be reached directly from the internet.",
          warning:
            "If it were public, anyone on the internet could try to connect. That is why it is not switched on yet.",
          unavailable: "Switching public access on or off is not available yet.",
        },
      },
      backups: {
        intro:
          "Before a database is deleted, a final backup is taken and kept for the restore period.",
        caption: "Database backups",
        name: "Name",
        kind: "Kind",
        size: "Size",
        date: "Date",
        state: "State",
        final: "Final backup",
        manual: "Taken by you",
        gb: "{size} GB",
        empty: {
          title: "No backup yet",
          body: "The final backup shows here once the database is deleted.",
        },
        createUnavailable: "Taking a backup yourself is not available yet.",
        restoreSoon: "Restoring from a backup is coming soon.",
        stateActive: "Ready",
        stateCreating: "Creating",
        stateOther: "—",
      },
      metrics: {
        unavailable: {
          title: "Metrics cannot be shown now",
          body: "The CPU and connection charts of a database are not in this panel yet. They are coming soon.",
        },
      },
      switch: {
        title: "Turn the database on or off",
        bodyOn:
          "While the database is stopped your app cannot connect. The data is kept and the price of the term stays the same.",
        bodyOff: "The database is stopped. When you start it, it works again on the same endpoint.",
        turnOff: "Stop",
        turnOn: "Start",
        unavailable: "The database cannot be started or stopped in this state.",
      },
      destroy: {
        title: "Delete this database",
        body: "Once deleted, your app can no longer connect. A final backup is taken first and kept for the restore period.",
        button: "Delete database",
        dialogTitle: "Delete this database?",
        dialogBody: "This cannot be undone. Type the name of the database to confirm.",
      },
    },
    order: { open: "Open the database" },
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      fresh_sign_in_required: "For your security, sign in again and then try once more.",
      flag_off: "This service is not open for you yet.",
      validation: "Some details are wrong. Please try again.",
      rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
      not_found: "This was not found.",
      name_mismatch: "The name does not match. Type exactly the same name.",
      not_allowed: "This cannot be done in the current state.",
      unavailable: "We could not finish this now. Please try again shortly.",
      prices_updating: "Prices are being updated. Please try again later.",
    },
    done: {
      started: "The request to start the database was taken.",
      stopped: "The request to stop the database was taken.",
      destroyQueued: "The request to delete was taken.",
      approval: "It takes effect after staff approval.",
    },
  },
};
