// English texts of the database snapshots, restore and point-in-time restore, and of the bucket access
// for a server (WPU-G9). Typed from the Bengali (U5).
export const dbg9En = {
  DbSnapshots: {
    error: {
      unauthenticated: "Your session ended. Sign in again.",
      fresh_sign_in_required: "For your safety, sign in again and then retry.",
      flag_off: "This service is not open to you right now.",
      validation: "Something you entered is wrong. Try again.",
      rate_limited: "Too many requests in a short time. Try again in a while.",
      not_found: "This was not found.",
      name_mismatch: "The name does not match.",
      not_allowed:
        "This cannot be done now. The database must be running, and no new snapshot can be taken past the limit of 10.",
      price_unavailable:
        "The snapshot price is not known right now, so new snapshots are switched off.",
      unavailable: "This could not be finished now. Try again in a moment.",
    },
    done: {
      snapshotCreated: "The snapshot request is taken. Look at the list in a moment.",
      snapshotDeleting: "The request to delete the snapshot is taken.",
    },
    approval: "The request waits for approval from our team.",
    field: { invalid: "The value of this field is not right." },
    title: "Snapshots and backups",
    intro:
      "Automatic backups of the database are kept for {days} days. A snapshot you take stays until you delete it. A snapshot always becomes a new database; this database is not changed.",
    price: {
      ready: "Snapshot price: <price></price> per GB per month, on the stored size.",
      unavailable:
        "The snapshot price is not known right now. No new snapshot can be taken until it is.",
    },
    create: {
      title: "Take a snapshot",
      name: "Snapshot name",
      hint: "Letters, digits, spaces, dots, hyphens and underscores, at most 60.",
      submit: "Take a snapshot",
      stopped: "The database must be running to take a snapshot.",
    },
    table: {
      caption: "Snapshots of the database",
      name: "Name",
      kind: "Kind",
      manual: "Taken by you",
      final: "Automatic, before a delete",
      size: "Size",
      gb: "{size} GB",
      monthly: "Price per month",
      date: "Date",
      state: "State",
      stateActive: "Ready",
      stateCreating: "Being made",
      stateOther: "Other state",
      none: "-",
      delete: "Delete",
      deleteTitle: "Delete the snapshot?",
      deleteBody:
        "A deleted snapshot cannot be brought back. Type the name of the snapshot below to confirm.",
    },
    empty: {
      title: "No snapshot yet",
      body: "Give a name in the box above and take the first snapshot.",
    },
    restore: {
      title: "New database from a snapshot",
      body: "A new database is made from the snapshot you choose. You confirm the price on the review page before anything is bought. The plan cannot have a smaller disk than this database.",
      snapshot: "Snapshot",
      plan: "Plan",
      planOption: "{specs} - <price></price> per month",
      planInvalid: "This plan cannot be used for the restore.",
      name: "Name of the new database",
      hint: "Letters, digits, spaces, dots, hyphens and underscores, at most 60.",
      submit: "Go to the review",
      none: "There is no ready snapshot or suitable plan to restore with right now.",
      error: { validation: "The snapshot, plan or name is not right." },
    },
    pitr: {
      title: "Go back to a point in time",
      body: "A new database is made from the state at any moment of the last {days} days. The time is Dhaka time. The latest possible time is 5 minutes ago.",
      when: "State at (Dhaka time)",
      whenHint: "Possible times: {from} to {to}.",
      whenInvalid: "The time is outside the range or could not be read.",
      plan: "Plan",
      name: "Name of the new database",
      submit: "Go to the review",
      none: "There is no suitable plan right now.",
    },
  },
  DbConnect: {
    username: "Master user name",
    usernamePending: "Shown when the database is ready",
    retentionNote: "Automatic backups. Your own snapshots stay until you delete them.",
    retention: "Backups are kept for: {days} days",
    maintenance: "Maintenance window (UTC)",
    maintenanceUnknown: "Not set",
  },
  BucketAccess: {
    done: { instanceAccessQueued: "The request to change the access of the server is taken." },
    mode: {
      title: "Current access",
      private: "Private: files can be read only with your keys.",
      public: "Open to all: anyone with the link can read the files.",
      unknown: "Not known yet. It shows here after you change it.",
    },
    instances: {
      title: "Access for servers",
      intro:
        "Let one of your servers into this bucket so the server can use it without separate keys. When the bucket is suspended all servers lose access; after it resumes you give it again.",
      server: "Server",
      none: "You have no running or stopped server to give access to.",
      allowed: "Has access",
      allow: "Give access",
      deny: "Remove access",
      empty: "No server has been given access yet.",
    },
  },
};
