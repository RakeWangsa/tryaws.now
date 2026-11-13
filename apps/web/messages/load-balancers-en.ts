import type { loadBalancersBn } from "./load-balancers-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const loadBalancersEn: Same<typeof loadBalancersBn> = {
  LoadBalancers: {
    meta: { title: "Load Balancers" },
    heading: "Load Balancers",
    awsNote:
      "Every load balancer is an Amazon Lightsail load balancer. It shares traffic between your servers in the same location.",
    flagOff: {
      title: "Load Balancers are coming soon",
      body: "This service is not open in your market yet. You will be able to buy it here once it opens.",
    },
    kycRequired: {
      title: "Verify your identity first",
      body: "Identity verification must be complete before you can buy a load balancer. Come back here when it is done.",
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
    list: {
      caption: "Your load balancers",
      name: "Name",
      location: "Location",
      targets: "Servers",
      state: "State",
      none: "—",
      create: "New load balancer",
      empty: {
        title: "No load balancer yet",
        body: "Put a load balancer in front of several servers to share the traffic.",
      },
    },
    new: {
      meta: { title: "New load balancer" },
      heading: "New load balancer",
      intro:
        "Choose a location and a plan, then pick targets from your own servers. A target must be running and in the same location as the load balancer.",
      step: {
        location: "1. Location",
        plan: "2. Plan",
        targets: "3. Target servers",
        name: "4. Name",
      },
      locationHint: "A load balancer and its target servers must be in the same location.",
      planLegend: "Choose a plan",
      planName: "Load balancer",
      planLine: "HTTP traffic, port 80",
      targetsHint: "Only your own running servers are listed. Pick at least one.",
      noTargetsInRegion: "You have no running server in this location.",
      nameHint: "For you only. Letters, digits, spaces, dots, underscores and hyphens.",
      namePlaceholder: "For example: my-site-front",
      httpNote:
        "A load balancer works with HTTP (port 80) for now. An HTTPS certificate cannot be added yet.",
      noPlans: {
        title: "No plan is for sale right now",
        body: "Please look again in a little while.",
      },
      noServers: {
        title: "No server to use as a target",
        body: "First get a running Cloud Server to put behind the load balancer.",
        action: "See Cloud Servers",
      },
      summary: {
        title: "Order summary",
        location: "Location",
        targets: "Target servers",
        term: "Term",
        termValue: "30 days",
        price: "Total price",
      },
      submit: "Go to review",
    },
    detail: {
      meta: { title: "Load balancer details" },
      back: "All load balancers",
      tabsLabel: "Load balancer sections",
      notFound: {
        title: "Load balancer not found",
        body: "This load balancer does not exist, or it is not in your account.",
      },
      header: { aws: "Amazon Lightsail load balancer" },
      tab: {
        overview: "Overview",
        targets: "Target servers",
        health: "Health and HTTPS",
        destroy: "Delete",
      },
      overview: {
        location: "Location",
        targets: "Target servers",
        created: "Created",
        recreated:
          "If it is deleted and later restored, the settings and the list of targets are kept.",
      },
      targets: {
        intro:
          "The load balancer sends traffic to these servers. Only your own servers can be added.",
        caption: "Target servers",
        name: "Name",
        state: "State",
        removed: "The server no longer exists",
        empty: {
          title: "No target server",
          body: "No server is attached to this load balancer now.",
        },
        edit: {
          title: "Change the target servers",
          hint: "Pick from your running servers in the same location. At least one must stay.",
          button: "Save targets",
          unavailable: "Changing the target servers is not available yet. It is coming soon.",
          noneToAdd: "You have no other running server in this location to add.",
        },
      },
      health: {
        title: "Health check",
        unavailable: {
          title: "Health cannot be shown now",
          body: "Look again in a moment. Your load balancer is not affected.",
        },
        notLive: {
          title: "No health to show yet",
          body: "Health is shown once the load balancer is ready.",
        },
        empty: {
          title: "No server to check",
          body: "No server is attached to this load balancer, so there is no health to show.",
        },
        checkedAt: "Checked at {time}. Reload the page to check again.",
        caption: "Health of the servers behind this load balancer",
        server: "Server",
        status: "Health",
        reasonHeader: "Reason",
        unresolved:
          "{count} more servers behind this load balancer are not known to this panel and are not listed.",
        state: {
          healthy: "Healthy",
          unhealthy: "Not healthy",
          initial: "Being checked",
          unused: "Not in use",
          draining: "Being removed",
          unavailable: "Not known",
        },
        reason: {
          registering: "Being added to the load balancer",
          initial_checks: "The first health checks are running",
          response_code_mismatch: "The server answers with an unexpected response code",
          timeout: "The server did not answer in time",
          failed_checks: "The server failed the health checks",
          internal_error: "The check could not be completed",
          not_registered: "The server is not added to the load balancer",
          not_in_use: "The load balancer sends no traffic to this server",
          ip_unusable: "The server address cannot be used",
          stopped: "The server is not running",
          deregistering: "The server is being removed from the load balancer",
          unknown: "Reason not known",
        },
        https: {
          title: "HTTPS certificate",
          body: "Adding an HTTPS certificate is not available yet. The load balancer works with HTTP (port 80) for now.",
        },
      },
      destroy: {
        title: "Delete this load balancer",
        body: "Once deleted, traffic is no longer shared. A load balancer has no snapshot; its settings are kept, and restoring it creates a new load balancer from them.",
        button: "Delete load balancer",
        dialogTitle: "Delete this load balancer?",
        dialogBody: "This cannot be undone. Type the name of the load balancer to confirm.",
      },
    },
    order: { open: "Open the load balancer" },
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
      targetsQueued: "The request to change the target servers was taken.",
      destroyQueued: "The request to delete was taken.",
      approval: "It takes effect after staff approval.",
    },
  },
};
