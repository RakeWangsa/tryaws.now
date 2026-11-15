import type { serversBn } from "./servers-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const serversEn: Same<typeof serversBn> = {
  Flow: {
    error: {
      unauthenticated: "Your session has ended. Please sign in again.",
      forbidden: "Your account is not allowed to do this.",
      kyc_required:
        "Finish the account setup before you buy a server: verify your e-mail and mobile number and switch on an authenticator app.",
      flag_off: "This service is not open for you yet.",
      limit_reached: "Your account has reached its server limit. Write to support to raise it.",
      validation: "Some details are wrong. Fix the marked fields and try again.",
      insufficient_balance: "Your wallet balance is not enough. Top up first.",
      capacity_full: "This location is full right now. Choose another location or try later.",
      rate_limited: "Too many requests in a short time. Please wait a moment and try again.",
      draft_expired: "The price has expired. Configure again to see the current price.",
      unavailable: "We could not finish this now. You were not charged. Please try again shortly.",
      prices_updating: "Prices are being updated. Please try again later.",
      conflict: "This key was already added under another name.",
      not_found: "This was not found.",
      name_mismatch: "The name does not match. Type exactly the same name.",
      fresh_sign_in_required: "For your security, sign in again and then try once more.",
    },
    reauthLink: "Sign in again",
    field: {
      invalid: "The value in this field is not valid.",
    },
    screen: {
      errorTitle: "This page could not be opened",
      errorBody: "A temporary problem happened. Please try again in a moment. Your money is safe.",
      retry: "Try again",
    },
  },
  Servers: {
    meta: { title: "Cloud Servers" },
    heading: "Cloud Servers",
    awsNote:
      "Every Cloud Server is an Amazon Lightsail instance running in the AWS Region you choose.",
    flagOff: {
      title: "Cloud Servers are coming soon",
      body: "This service is not open in your market yet. You will be able to buy it here once it opens.",
    },
    list: {
      caption: "Your Cloud Servers",
      name: "Name",
      plan: "Plan",
      location: "Location",
      ip: "Public IP",
      state: "State",
      none: "—",
      create: "New server",
      empty: {
        title: "No servers yet",
        body: "Your first Cloud Server is ready in a few minutes.",
      },
    },
    spec: {
      vcpus: "{count} vCPU",
      ram: "{size} GB RAM",
      disk: "{size} GB disk",
      transfer: "{size} GB transfer",
    },
    region: {
      "ap-south-1": "Asia Pacific (Mumbai)",
      "ap-southeast-1": "Asia Pacific (Singapore)",
      "ap-southeast-2": "Asia Pacific (Sydney)",
      "ap-northeast-1": "Asia Pacific (Tokyo)",
      "eu-west-2": "Europe (London)",
      "eu-central-1": "Europe (Frankfurt)",
      "us-east-1": "US East (N. Virginia)",
    },
    new: {
      meta: { title: "New Cloud Server" },
      heading: "New Cloud Server",
      intro:
        "Cloud Server, built on Amazon Lightsail. Choose, see the price, then pay from your wallet.",
      step: {
        location: "Location",
        image: "Image",
        plan: "Plan",
        key: "SSH key",
        name: "Server name",
      },
      locationHint: "The name and code of the AWS Region are shown.",
      planLegend: "Choose a plan",
      imageHint:
        "The server is built from this image. Choose an operating system alone, or an operating system with an app.",
      imageApps: "Apps + OS",
      imageOs: "OS only",
      imageUser: "Login user: {user}",
      imageUserUnknown: "The login user is in the image notes",
      noImages: {
        title: "No image is available in this location right now",
        body: "Choose another location, or check again in a little while.",
      },
      keyRequired:
        "An SSH key is needed to log in to the server. Only the public key is sent; the private key stays with you.",
      noKeys: {
        title: "Add an SSH key first",
        body: "Create a key or add your public key, then come back here to create the server.",
        action: "Add an SSH key",
      },
      keyHint: "Only public keys are used. To add a new key,",
      keyLink: "go to the SSH keys page",
      keyMode: {
        existing: "Use a key I already have",
        generate: "Create a new key pair",
        paste: "Upload my public key",
      },
      keyName: "Key name",
      keyNameHint: "English letters, digits, spaces, dots, dashes and underscores, up to 60.",
      keyNameTaken: "You already have another key with this name. Use a different name.",
      keyNotUsable: "{name} (cannot start a server: not an RSA key of 2048 bits or more)",
      keyPublic: "Public key",
      keyPublicHint:
        "One line that starts with ssh-rsa (an RSA key of 2048 bits or more). Never paste a private key here.",
      keyGenerate: "Create key pair",
      keyGenerateHint:
        "The key pair is made in your browser. The private key never reaches us; you can download it once.",
      keyMade:
        "The key pair is ready. Download the private key now. It is not shown again, and we do not keep it.",
      keyDownload: "Download private key",
      keySaved:
        "The private key was downloaded. Keep it somewhere safe; it cannot be downloaded again. You can create the server now.",
      keyUnsupported:
        "This browser cannot create keys. Use a key you already have, or upload your public key.",
      keyFailed: "The key could not be created. Try again.",
      planTooSmallShort: "Too small for this image",
      planMin: "{image} needs a plan with {size} or more. Smaller plans cannot be chosen.",
      planNoneFit:
        "No plan in this location is big enough to run {image}. Choose another image or location.",
      planTooSmall: "This plan is too small for the image. Choose a larger plan.",
      nameHint: "English letters, digits, spaces, dots, dashes and underscores, up to 60.",
      namePlaceholder: "my-server",
      summary: {
        title: "Order summary",
        plan: "Plan",
        location: "Location",
        image: "Image",
        term: "Term",
        termValue: "30 days",
        price: "Total price",
      },
      submit: "See the price and review",
      noPlans: {
        title: "No plans are for sale right now",
        body: "Check again in a little while, or write to support.",
      },
    },
    detail: {
      meta: { title: "Server details" },
      back: "All servers",
      tabsLabel: "Server tabs",
      notFound: {
        title: "Server not found",
        body: "Check the link, or go back to the list of servers.",
      },
      header: {
        aws: "Amazon Lightsail instance",
      },
      tab: { overview: "Overview", access: "Access", networking: "Networking" },
      overview: {
        specs: "Specifications",
        addresses: "Addresses",
        created: "Created on",
        publicIp: "Public IP",
        pendingIp: "The IP address shows here once the server is ready.",
        location: "Location",
      },
      access: {
        ssh: "SSH command",
        sshHint:
          "Run it in a terminal on your computer, in the folder that holds your private key file. Never give your private key to anyone.",
        user: "Login user",
        userUnknown:
          "We could not tell the login user of this image. Use the user name from the image notes.",
        keyFile: "Key file",
        keyFileHint:
          "This is the private key you saved when you created the key. On macOS or Linux run chmod 400 {file} once so that SSH accepts it. We never hold your private key.",
        appPassword: "Application password",
        appPasswordHint:
          "The default password of the application on this image is kept on the server in {file}. Connect with SSH, then run this command to read it. Change the password after your first sign-in.",
        image: "Image",
        keyName: "Attached key",
        noKey: "No SSH key was attached to this server.",
        pendingIp: "The command shows here once the IP address is known.",
        rdp: "Remote Desktop address",
        rdpHint: "Open Remote Desktop on your computer and connect to this address.",
      },
      networking: {
        title: "Firewall and static IP",
        note: "These rules filter public traffic only. Port 80 is reachable on the private network from other servers in the same Region, and private traffic between your own servers is blocked.",
        staticIp: "Static IP",
        staticIpHint: "Every server comes with one static IP.",
        rulesTitle: "Firewall rules",
        rulesIntro:
          "The rules decide which traffic from the internet reaches your server. They apply to IPv4. IPv6 is not switched on for these servers yet.",
      },
      manage: {
        flagOff: "Managing this server is not open for you yet.",
        busy: "A change to this server is being applied. The buttons come back when it is done.",
        power: {
          label: "Power",
          reboot: "Reboot",
          stop: "Stop",
          start: "Start",
          stopNote: "A stopped server is still billed for its plan.",
        },
        rename: {
          title: "Rename",
          name: "Server name",
          hint: "Letters, digits, space, dot, dash and underscore, up to 60.",
          submit: "Save name",
        },
        firewall: {
          caption: "Firewall rules of this server",
          application: "Application",
          protocol: "Protocol",
          ports: "Port range",
          source: "Restricted to",
          action: "Action",
          remove: "Remove",
          anyIpv4: "Any IPv4 address",
          presets: {
            ssh: "SSH",
            http: "HTTP",
            https: "HTTPS",
            rdp: "RDP",
            ping: "Ping (ICMP)",
            custom: "Custom",
          },
          empty: {
            title: "No rules",
            body: "All traffic from the internet to this server is blocked.",
          },
          unreadable: "The rules of this server cannot be shown now. Please try again shortly.",
          sshWarning:
            "SSH (port 22) is open to every address. Restrict it to your own IP address to keep your server safe.",
          addTitle: "Add a rule",
          preset: "Application",
          protocolField: "Protocol",
          fromPort: "Port, or first port of the range",
          toPort: "Last port (optional)",
          sourceMode: "Source",
          sourceAny: "Any IPv4 address",
          sourceRestrict: "Only these IP addresses",
          sources: "IP addresses or CIDR blocks",
          sourcesHint: "Separate them with commas or new lines. Example: 203.0.113.7, 10.0.0.0/8",
          submit: "Add rule",
          fieldError: {
            invalid: "This is not valid.",
            ipv6: "IPv6 addresses are not supported for these servers.",
            too_many: "Use at most 20 addresses.",
          },
        },
        staticIp: {
          title: "Static IP",
          attached:
            "The static IP is attached. The address stays the same when the server restarts.",
          detached:
            "No static IP is attached. The server has an address of its own that changes when the server is stopped.",
          address: "Current address",
          detachWarn:
            "After you detach it, the server gets a new address. Anything that uses the current address, such as DNS records, stops working.",
          free: "Free while attached.",
          detachFee:
            "Amazon Lightsail charges a static IP that is not attached {price} per hour after the first hour. The charge is taken from your wallet and stops when you attach it again.",
          feeWaiting:
            "Not attached: charged {price} per hour after the first hour. Attach it again to avoid the charge.",
          feeNoPrice:
            "Not attached: charged by the hour after the first hour. The price is not available right now.",
          charging: "Charging now",
          chargingNote: "{price} per hour is being taken from your wallet.",
          chargingNoPrice: "An hourly charge is being taken from your wallet.",
          attachNote: "Attaching it stops the hourly charge.",
          acknowledge: "I understand that the address will change",
          detach: "Detach static IP",
          attach: "Attach static IP",
        },
      },
    },
    state: {
      creating: "Creating",
      active: "Running",
      stopped: "Stopped",
      suspended: "Suspended",
      destroyed: "Deleted",
      failed: "Problem",
    },
  },
  Orders: {
    review: {
      meta: { title: "Review order" },
      heading: "Review order",
      caption: "Order lines",
      item: "Server",
      itemValue: "{name} · Cloud Server",
      // WPU-X20: every family other than a server had the line "Server / Cloud Server" and a Region. The line
      // names the product (16.13); a global service (DNS zone, domain, CDN) has no Region.
      itemOther: "Service",
      itemValueOther: "{name} · {product}",
      product: {
        disk: "Block Storage",
        bucket: "Object Storage",
        database: "Managed Database",
        loadBalancer: "Load Balancer",
        containerService: "Container Service",
        cdn: "CDN, on Amazon Lightsail CDN",
        dnsZone: "DNS zone, on Amazon Route 53",
        domain: "Domain, on Amazon Route 53",
        staticIp: "Static IP",
        backup: "Backup",
      },
      locationGlobal: {
        cdn: "Worldwide (a global service of Amazon Lightsail CDN)",
        dnsZone: "Worldwide (a global service of Amazon Route 53)",
        domain: "Worldwide (a global service of Amazon Route 53)",
      },
      renewalOther:
        "At the end of the term the renewal is paid from your wallet. You can turn automatic renewal off on the page of this service.",
      location: "Location",
      plan: "Plan",
      term: "Term",
      termValue: "30 days",
      // WPU-X23: a domain is bought for one year, not for the 30 days of a Lightsail subscription.
      termValueDomain: "1 year",
      renewal:
        "At the end of the term the renewal is paid from your wallet. You can turn automatic renewal off; the server is then suspended.",
      // WPU-Z2, WPU-Z14: shown for a family that a purchase opens with auto-renew on (owner decision of
      // 2026-11-13; autoRenewAtPurchase of @tc/core): every family with a subscription. Each has the switch
      // on its own page (a Linux server: Billing tab; a disk: the Storage tab of its server).
      autoRenew:
        "Auto-renew is on: the next period is paid from your wallet when this one ends. You can turn it off at any time on the page of this service in the panel.",
      // WPU-X16 (owner decision of 2026-11-15): taka only; no dollar price and no exchange rate for customers.
      debit: {
        caption: "Amount in taka",
        bdt: "Amount debited from your wallet (taka)",
        note: "The price is in taka (BDT), for 30 days, with VAT and fees included. Exactly this amount is taken from your wallet. If the price changes before you confirm, you will see the new amount and confirm again.",
        noteDomain:
          "The price is in taka (BDT), for 1 year, with VAT and fees included. Exactly this amount is taken from your wallet. If the price changes before you confirm, you will see the new amount and confirm again.",
      },
      lines: "Price details",
      awsPrice: "Service price (Amazon Web Services)",
      step: {
        bd_vat: "VAT",
        processing_fee: "Processing fee",
        markup: "Service charge",
      },
      total: "Total",
      balance: "Wallet balance",
      balanceAfter: "Balance after purchase",
      shortfall: "Shortfall",
      shortfallBody: "Your wallet is short by {amount}. Top up and come back here.",
      topUp: "Top up",
      terms: "I have read and accept the terms and the refund policy.",
      termsRequired: "Accept the terms to continue.",
      confirm: "Buy",
      confirmSummary: "Order summary",
      validUntil: "This price is valid until {time}.",
      back: "Back to the configuration",
      priceChanged: {
        title: "The price changed",
        body: "The price or the rules changed after the price you saw. Check the new price and confirm again.",
        old: "Earlier price",
        new: "New price",
      },
      invalid: {
        title: "This review link is not valid",
        body: "Configure again to see the price.",
      },
      expired: {
        title: "The price has expired",
        body: "A price is valid for 30 minutes. Configure again to see the current price.",
      },
      unavailable: {
        title: "Ordering is not available right now",
        body: "Please try again later. Nothing was taken from your wallet.",
      },
    },
    status: {
      meta: { title: "Order status" },
      heading: "Order status",
      label: "Order steps",
      total: "Total price",
      // The noun of the product family that was bought (WPU-R1): the step labels and the notes
      // say what the customer ordered, a disk is not called a server. `noun` is for the middle of a
      // sentence, `title` for the start of a label.
      noun: {
        server: "server",
        disk: "disk",
        bucket: "bucket",
        database: "database",
        loadBalancer: "load balancer",
        containerService: "container service",
        cdn: "CDN",
        dnsZone: "DNS zone",
        domain: "domain",
        staticIp: "static IP",
        backup: "backup",
      },
      title: {
        server: "Server",
        disk: "Disk",
        bucket: "Bucket",
        database: "Database",
        loadBalancer: "Load balancer",
        containerService: "Container service",
        cdn: "CDN",
        dnsZone: "DNS zone",
        domain: "Domain",
        staticIp: "Static IP",
        backup: "Backup",
      },
      step: {
        paid: "Paid",
        creating: "Creating the {noun}",
        ready: "{title} ready",
      },
      ready: "Your {noun} is ready.",
      openServer: "Open the server",
      readyDisk:
        "Your disk is ready. Attach it to a server from the list of free disks in the Storage tab of the server.",
      openDisk: "My servers",
      creating: "Your {noun} is being created. This page updates by itself.",
      delayed: "Your order is delayed. Support is looking into it. You do not need to do anything.",
      failed:
        "The {noun} could not be created. The amount you paid is returned to your wallet automatically. The refund line shows in your wallet transactions.",
      slow: "Your {noun} is taking longer than usual. We are still working on it. If we cannot complete it, your payment is returned to your wallet.",
      failedRefunded:
        "We could not create your {noun}. Your payment has been returned to your wallet.",
      refunded: "Returned to your wallet:",
      wallet: "View wallet",
      notFound: {
        title: "Order not found",
        body: "Check the link.",
        action: "Your servers",
      },
    },
  },
  SshKeys: {
    meta: { title: "SSH keys" },
    heading: "SSH keys",
    intro: "Add public keys only. Never paste a private key here.",
    list: {
      caption: "Your SSH keys",
      name: "Name",
      fingerprint: "Fingerprint",
      added: "Added",
      remove: "Remove",
      empty: {
        title: "No SSH keys",
        body: "Add a public key to choose it on a new server.",
      },
    },
    add: {
      title: "Add a new key",
      name: "Key name",
      nameHint: "English letters, digits, spaces, dots, dashes and underscores.",
      publicKey: "Public key",
      publicKeyHint: "One line that starts with ssh-rsa (an RSA key of 2048 bits or more).",
      submit: "Add key",
      done: "The key was added.",
      replayed: "This key was already added.",
    },
    confirm: {
      title: "Remove this key?",
      description:
        "A removed key can no longer be chosen on a new server. Servers that already have it keep working. Type the name of the key to confirm.",
      removed: "The key was removed.",
    },
    flagOff: {
      title: "SSH keys are coming soon",
      body: "You can add keys here once Cloud Servers open.",
    },
  },
};
