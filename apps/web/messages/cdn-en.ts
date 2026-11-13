import type { cdnBn } from "./cdn-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const cdnEn: Same<typeof cdnBn> = {
  Cdn: {
    meta: { title: "CDN" },
    heading: "CDN",
    awsNote:
      "Every CDN is an Amazon Lightsail CDN distribution. Copies of your content are kept at AWS edge locations worldwide.",
    flagOff: {
      title: "CDN is coming soon",
      body: "This service is not open in your market yet. You will be able to buy it here once it opens.",
    },
    kycRequired: {
      title: "Verify your identity first",
      body: "Identity verification must be complete before you can buy a CDN. Come back here when it is done.",
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
    cache: {
      cache: "Cache content",
      "dont-cache": "Do not cache",
    },
    origin: {
      server: "Cloud Server",
      loadBalancer: "Load Balancer",
      bucket: "Object Storage",
      none: "Not found",
    },
    plan: {
      small: "Small",
      medium: "Medium",
      large: "Large",
      transfer: "{size} GB data transfer a month",
    },
    list: {
      caption: "Your CDNs",
      name: "Name",
      origin: "Origin",
      domain: "Default domain",
      state: "State",
      none: "—",
      create: "New CDN",
      empty: {
        title: "No CDN yet",
        body: "Put a CDN in front of your server, load balancer or object storage.",
      },
    },
    new: {
      meta: { title: "New CDN" },
      heading: "New CDN",
      intro:
        "A CDN keeps copies of your content close to your visitors. Choose your own server, load balancer or object storage as the origin.",
      step: {
        origin: "1. Origin",
        plan: "2. Plan",
        cache: "3. Cache behavior",
        name: "4. Name",
      },
      originHint:
        "Only your own running servers, load balancers and object storage are listed. A server needs a static IP attached.",
      planLegend: "Choose a plan",
      cacheHint:
        "Cache content suits a static site. Turn caching off for content that changes for each visitor.",
      nameHint: "For you only. Letters, digits, spaces, dots, underscores and hyphens.",
      namePlaceholder: "For example: my-site-cdn",
      noPlans: {
        title: "No plan is for sale right now",
        body: "Please look again in a little while.",
      },
      noOrigins: {
        title: "No origin for a CDN yet",
        body: "First get a running Cloud Server, Load Balancer or Object Storage.",
        action: "See Cloud Servers",
      },
      customDomainNote:
        "Your own domain and certificate cannot be added yet. Use the default domain you get once the CDN is created.",
      summary: {
        title: "Order summary",
        origin: "Origin",
        cache: "Cache",
        term: "Term",
        termValue: "30 days",
        price: "Total price",
      },
      submit: "Go to review",
    },
    detail: {
      meta: { title: "CDN details" },
      back: "All CDNs",
      tabsLabel: "CDN sections",
      notFound: {
        title: "CDN not found",
        body: "This CDN does not exist, or it is not in your account.",
      },
      header: { aws: "Amazon Lightsail CDN distribution" },
      tab: { overview: "Overview", settings: "Settings", destroy: "Delete" },
      overview: {
        origin: "Origin",
        cache: "Cache behavior",
        location: "Location",
        locationValue: "Edge locations worldwide",
        domain: "Default domain",
        domainHint: "Use this address in links on your website or in DNS.",
        domainPending: "The domain will show here once it is created.",
        created: "Created",
        recreated:
          "If it is deleted and later restored, the settings are kept but the default domain changes.",
      },
      switch: {
        title: "Turn the CDN on or off",
        bodyOn:
          "While the CDN is off, visitors get no copies. The settings are kept and the price of the term stays the same.",
        bodyOff: "The CDN is off. When you turn it on it works again on the same domain.",
        turnOff: "Turn off",
        turnOn: "Turn on",
        unavailable: "The CDN cannot be turned on or off in this state.",
      },
      destroy: {
        title: "Delete this CDN",
        body: "Once deleted, the default domain stops working. A CDN has no snapshot; its settings are kept, and restoring it creates a new CDN from them.",
        button: "Delete CDN",
        dialogTitle: "Delete this CDN?",
        dialogBody: "This cannot be undone. Type the name of the CDN to confirm.",
      },
    },
    order: { open: "Open the CDN" },
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      fresh_sign_in_required: "For your security, sign in again and then try once more.",
      flag_off: "This service is not open for you yet.",
      validation: "Some details are wrong. Please try again.",
      rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
      not_found: "This was not found.",
      name_mismatch: "The name does not match. Type exactly the same name.",
      not_allowed: "This cannot be done in the current state.",
      busy: "A new plan is being applied to this CDN now. Try again when it is done.",
      unavailable: "We could not finish this now. Please try again shortly.",
      prices_updating: "Prices are being updated. Please try again later.",
    },
    done: {
      enabled: "The request to turn the CDN on was taken.",
      disabled: "The request to turn the CDN off was taken.",
      destroyQueued: "The request to delete was taken.",
      approval: "It takes effect after staff approval.",
    },
  },
};
