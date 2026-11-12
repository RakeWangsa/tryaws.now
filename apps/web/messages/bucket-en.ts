import type { bucketBn } from "./bucket-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const bucketEn: Same<typeof bucketBn> = {
  Storage: {
    meta: { title: "Object Storage" },
    heading: "Object Storage",
    awsNote:
      "Every bucket is an Amazon Lightsail object storage bucket. Your files stay in the AWS Region you choose.",
    flagOff: {
      title: "Object Storage is coming soon",
      body: "This service is not open in your market yet. You will be able to buy it here once it opens.",
    },
    kycRequired: {
      title: "Verify your identity first",
      body: "Identity verification must be complete before you can buy Object Storage. Come back here when it is done.",
      action: "Write to support",
    },
    state: {
      creating: "Creating",
      active: "On",
      stopped: "Off",
      suspended: "Suspended",
      destroyed: "Deleted",
      failed: "Problem",
    },
    access: {
      private: "Private",
      public: "Public",
      unknown: "Not shown here",
    },
    plan: {
      generic: "Storage plan",
      storage: "{size} GB storage",
      transfer: "{size} GB data transfer a month",
    },
    opState: {
      queued: "Waiting",
      running: "Running",
      waiting: "Waiting",
      needs_approval: "Waiting for approval",
      succeeded: "Done",
      failed: "Failed",
      needs_attention: "Being looked at",
      cancelled: "Cancelled",
    },
    list: {
      caption: "Your buckets",
      name: "Name",
      bucket: "Bucket name",
      location: "Location",
      state: "State",
      none: "—",
      create: "New bucket",
      empty: {
        title: "No bucket yet",
        body: "Create your first bucket to keep images, backups or website files.",
      },
    },
    new: {
      meta: { title: "New bucket" },
      heading: "New Object Storage",
      intro:
        "Object Storage, built on Amazon Lightsail. Choose a plan, see the price, then pay from your wallet.",
      step: { plan: "1. Plan", access: "2. Access", name: "3. Name" },
      planLegend: "Choose a plan",
      accessNote:
        "A new bucket is always private. After you buy it you can make it public from the bucket page, which needs a separate confirmation.",
      nameHint: "For you only. Letters, digits, spaces, dots, underscores and hyphens.",
      namePlaceholder: "For example: site-assets",
      bucketNameNote:
        "We generate the real bucket name ourselves. Once the bucket exists it is shown on its page, because it is part of the address of the bucket.",
      noPlans: {
        title: "No plan is for sale right now",
        body: "Please look again in a little while.",
      },
      summary: {
        title: "Order summary",
        access: "Access",
        accessValue: "Private",
        term: "Term",
        termValue: "30 days",
        price: "Total price",
      },
      submit: "Go to review",
    },
    detail: {
      meta: { title: "Bucket details" },
      back: "All buckets",
      tabsLabel: "Bucket sections",
      notFound: {
        title: "Bucket not found",
        body: "This bucket does not exist, or it is not in your account.",
      },
      header: { aws: "Amazon Lightsail object storage bucket" },
      tab: { overview: "Overview", access: "Access", keys: "Access keys", destroy: "Delete" },
      overview: {
        bucketName: "Bucket name",
        bucketNameHint:
          "This name is part of the address of the bucket. Use it in your app or tool.",
        address: "Bucket address",
        location: "Location",
        access: "Access",
        accessUnknown: "The current mode cannot be read on this page. A new bucket is private.",
        usage: "Usage",
        usageUnavailable: "The amount used cannot be shown here yet.",
        created: "Created",
        requests: "Recent requests",
        requestsNone: "No requests yet.",
        request: { access: "Access change", key: "Key deletion" },
      },
      access: {
        title: "Access",
        body: "Files in a private bucket can be read only with an access key. Files in a public bucket can be read by anyone who knows the address.",
        notActive: "Access cannot be changed unless the bucket is on.",
        makePrivate: "Make private",
        makePublic: "Make public",
        publicWarning:
          "If you make the bucket public, anyone on the internet can see and download every file in it. Downloads use the data transfer of your plan. Do not make it public if it holds private or secret files.",
        confirmLabel: "Type {word} to confirm",
        confirmHint: "Type it exactly like this.",
        publicAction: "Request public access",
      },
      keys: {
        title: "Access keys",
        intro:
          "Your app or tool uses an access key to read and write files in the bucket. A bucket can hold at most two keys.",
        warning:
          "The secret key is shown only once and is hidden again after 60 seconds. Copy it now and keep it somewhere safe. If you lose it, make a new key.",
        create: "Make a new key",
        working: "Making the key…",
        keyId: "Key ID",
        secret: "Secret key",
        gone: "The secret key is no longer shown. Make a new key if you need one.",
        notReady: "A key cannot be made unless the bucket is on.",
        confirmLabel: "Type the name of the bucket to confirm",
        confirmHint: "Type the name of the bucket exactly as shown at the top of this page.",
        listTitle: "Keys of this bucket",
        listEmpty: "This bucket has no access key yet.",
        listUnavailable:
          "The list of keys cannot be shown now. Reload the page in a moment. The key ID is shown once when you make the key, so write it down.",
        listKeyId: "Key ID",
        listStatus: "Status",
        listCreated: "Created",
        status: { active: "In use", inactive: "Off" },
        deleteNameLabel: "Type the name of the bucket to confirm",
        deleteNameHint: "Type the name of the bucket exactly as shown at the top of this page.",
        deleteStale: "A key can be deleted only after you sign in again.",
        deleteTitle: "Delete a key",
        deleteBody:
          "Once deleted, any app that uses that key stops reading and writing files at once.",
        deleteField: "Key ID",
        deleteHint: "Type the ID of the key you want to delete.",
        deletePlaceholder: "For example: AKIA…",
        delete: "Delete key",
        rotateTitle: "To replace a key",
        rotateSteps:
          "1. Make a new key. 2. Put the new key in your app. 3. When the app works, delete the old key. A bucket holds two keys at most, so keep one place free first.",
      },
      destroy: {
        title: "Delete this bucket",
        body: "Once deleted, every file in the bucket is gone for good. A bucket has no snapshot, so there is no way to bring it back. Move the files you need somewhere else first.",
        closed:
          "Deleting a bucket is not open yet. When and under which conditions a bucket can be deleted has not been decided. Write to support if you need it.",
        button: "Delete bucket",
        dialogTitle: "Delete this bucket?",
        dialogBody: "This cannot be undone. Type the name of the bucket to confirm.",
      },
    },
    order: { open: "Open the bucket" },
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      fresh_sign_in_required: "For your security, sign in again and then try once more.",
      flag_off: "This service is not open for you yet.",
      validation: "Some details are wrong. Please try again.",
      rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
      not_found: "This was not found.",
      name_mismatch: "The name does not match. Type exactly the same name.",
      confirm_required: "To make it public, type the confirmation text exactly as asked.",
      not_allowed: "This cannot be done in the current state.",
      not_ready: "The bucket is not on right now.",
      limit_reached: "The bucket already has two keys. Delete one first.",
      already_created:
        "This key was already made, and its secret key cannot be shown again. Delete it and make a new key if you lost the secret.",
      unavailable: "We could not finish this now. Please try again shortly.",
    },
    done: {
      accessPrivate: "The request to make the bucket private was taken.",
      accessPublic: "The request to make the bucket public was taken.",
      keyDeleted: "The request to delete the key was taken.",
      destroyQueued: "The request to delete was taken.",
      approval: "It takes effect after staff approval.",
    },
  },
};
