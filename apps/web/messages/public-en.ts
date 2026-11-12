import type { publicBn } from "./public-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

// The legal documents below are PLACEHOLDERS (JOURNEY.md, "Needs decision"): no sentence of them is
// final legal wording.
export const publicEn: Same<typeof publicBn> = {
  Public: {
    crumb: { home: "Home" },
    meta: {
      home: {
        title: "MeghVPS: Cloud Server, built on Amazon Lightsail",
        description:
          "Prepaid cloud panel for Bangladesh. Cloud Server, built on Amazon Lightsail. Prices in taka, top up with EPS.",
      },
      pricing: {
        title: "Pricing: Cloud Server, built on Amazon Lightsail",
        description:
          "Cloud Server plans with prices in taka for 30 days. Prices include VAT and fees. Built on Amazon Lightsail.",
      },
      cloudServers: {
        title: "Cloud Server, built on Amazon Lightsail",
        description:
          "Cloud servers that run in the AWS Region Singapore or Mumbai. Plans, specifications and prices in taka. Built on Amazon Lightsail.",
      },
      help: {
        title: "Help and frequently asked questions",
        description:
          "Answers about MeghVPS and Amazon Lightsail: AWS, billing, support and where your data is.",
      },
      support: {
        title: "Support and contact",
        description: "How to reach the MeghVPS support team.",
      },
      legal: {
        title: "Legal documents",
        description: "MeghVPS terms, privacy, acceptable use and refund policy.",
      },
      soon: {
        description:
          "This product is not open yet. Leave your email address to hear when it opens.",
      },
      maintenance: { title: "Under maintenance" },
    },
    common: {
      orderNow: "Order now",
      seePricing: "See pricing",
      seePlans: "See plans",
      login: "Go to the panel",
      priceNote:
        "Every price is in taka, for 30 days, and includes VAT and fees. Rounded up to whole taka.",
      unavailableTitle: "Prices cannot be shown now",
      unavailableText: "The price list cannot be read at the moment. Try again in a little while.",
      noPlansTitle: "No plan is open yet",
      noPlansText: "Plans will show here when Cloud Server opens.",
      locationHeading: "Location",
      comingSoon: "Coming soon",
    },
    location: {
      "ap-southeast-1": "Singapore",
      "ap-south-1": "Mumbai",
    },
    product: {
      linux_instance: "Cloud Server",
      windows_instance: "Cloud Server (Windows)",
      database: "Managed Database",
    },
    spec: {
      cpu: "vCPU",
      ram: "Memory",
      disk: "Disk",
      transfer: "Data transfer",
      cpuValue: "{count} vCPU",
      gb: "{count} GB",
      planOf: "{product} {ram} GB",
      nameAt: "{name} · {location}",
      none: "–",
      perLocation: "{location}: {value}",
    },
    home: {
      heroTitle: "Cloud Server, built on Amazon Lightsail",
      heroLead:
        "A prepaid cloud panel for Bangladesh. Prices in taka, top up your wallet with EPS. Run everything from one panel.",
      plansTitle: "Popular Cloud Server plans",
      plansLead:
        "The lowest priced open plans right now. Every price comes straight from the price list.",
      whyTitle: "Why MeghVPS",
      why: {
        aws: {
          title: "100% AWS infrastructure",
          text: "Every server is an Amazon Lightsail resource that runs in the AWS Region you choose.",
        },
        bdt: {
          title: "Prices in taka, top up first",
          text: "Add money to your wallet with EPS, then buy from it.",
        },
        panel: {
          title: "One panel, no separate AWS account",
          text: "Create, start, stop and back up servers from the MeghVPS panel. You do not need the AWS console.",
        },
        support: {
          title: "MeghVPS bills and supports you",
          text: "MeghVPS sells, bills and supports the service. Ask us directly.",
        },
      },
      locationsTitle: "Two locations",
      locationsText:
        "Two AWS Regions at the start: Singapore (ap-southeast-1) and Mumbai (ap-south-1). The data transfer of a plan can differ by location.",
      helpTitle: "Need help?",
      help: {
        faq: { title: "Questions", text: "Answers on AWS, billing and data" },
        support: { title: "Support", text: "Get in touch with us" },
        pricing: { title: "Pricing", text: "All plans and prices together" },
      },
    },
    pricing: {
      heading: "Pricing",
      lead: "Cloud Server, built on Amazon Lightsail. Every price is for 30 days, in taka.",
      tabsLabel: "Product type",
      tabCloudServers: "Cloud Server",
      tableTitle: "Compare plans",
      colPlan: "Plan",
      colMemory: "Memory",
      colDisk: "Disk",
      colTransfer: "Data transfer",
      colMonthly: "30 days",
      colOrder: "Order",
      tableCaption: "Cloud Server plans and prices by location",
      otherFamilies: "Other products",
      otherFamiliesText: "These products open step by step. Their prices show here when they open.",
    },
    cloudServers: {
      heading: "Cloud Server, built on Amazon Lightsail",
      lead: "Every Cloud Server is an Amazon Lightsail instance that runs in the AWS Region Singapore or Mumbai.",
      plansTitle: "Plans",
      featuresTitle: "What you get",
      features: {
        panel: {
          title: "A simple panel",
          text: "Create servers, reboot them and manage firewall rules and SSH keys in one place.",
        },
        backup: {
          title: "Backups",
          text: "Take and restore backups from the panel.",
        },
        bdt: { title: "Prepaid in taka", text: "Top up your wallet, then buy a server." },
        locations: {
          title: "Two locations",
          text: "Singapore or Mumbai, whichever is closer to your users.",
        },
      },
      pickerTitle: "Choose your plan",
      pickerLegend: "Plan",
      specsTitle: "Specifications",
      colLocation: "Location",
      faqTitle: "Questions about this product",
    },
    soon: {
      title: "{name} is coming soon",
      text: "This product is not open yet. We will email you when it opens.",
      formLabel: "Tell me when {name} opens",
      email: "Email",
      emailPlaceholder: "name@example.com",
      submit: "Notify me",
      sending: "Sending",
      doneTitle: "Thank you",
      done: "We will email you when the product opens.",
      back: "Back to pricing",
      error: {
        invalid: "Enter a valid email address.",
        rate_limited: "Too many tries. Try again in a little while.",
        unavailable: "We cannot save this now. Try again in a little while.",
      },
    },
    family: {
      databases: "Managed Database",
      objectStorage: "Object Storage",
      loadBalancers: "Load Balancer",
      containers: "Container Service",
      cdn: "CDN",
      dns: "DNS",
      domains: "Domains",
    },
    familyOpen: {
      text: "This product is open. Go to the panel to see plans and prices and to buy.",
    },
    help: {
      heading: "Frequently asked questions",
      lead: "The questions we hear most about MeghVPS and Amazon Lightsail.",
      listTitle: "Questions and answers",
      stillTitle: "Did not find an answer?",
      stillText: "Tell us on the support page.",
      items: {
        realAws: {
          q: "Is this real AWS?",
          a: "Yes, 100%. Every server, database, disk and bucket you buy here is an Amazon Lightsail resource that runs in the AWS Region you choose.",
        },
        noAccount: {
          q: "Do I get an AWS account or the AWS console?",
          a: "No. You run everything from the MeghVPS panel. You do not need a separate AWS account or the AWS console.",
        },
        billing: {
          q: "Who bills me and who supports me?",
          a: "MeghVPS. We sell, bill and support the service.",
        },
        dataLocation: {
          q: "Where is my data?",
          a: "Servers, databases, disks and buckets are in the AWS Region you choose. CDN copies are at AWS edge locations worldwide. DNS is a global service. Your account and identity documents are kept in AWS Singapore.",
        },
        payment: {
          q: "How do I pay?",
          a: "Top up your wallet with EPS first, then buy servers from the wallet. All amounts are in taka.",
        },
        priceIncludes: {
          q: "What does the price include?",
          a: "A displayed price is for 30 days and includes VAT and fees. It is rounded up to whole taka, so you are never charged more than the price shown.",
        },
        locations: {
          q: "Which locations are there?",
          a: "Two AWS Regions at the start: Singapore and Mumbai. The data transfer of a plan can differ by location, so the price list shows the value for each location.",
        },
        identity: {
          q: "Do I need an identity check before I buy a server?",
          a: "Yes. You complete an identity check once before you buy a server. Our staff review it and tell you the result.",
        },
        products: {
          q: "When do databases, storage and other products come?",
          a: "Products open step by step. If one is not open yet, leave your email on its page and we will tell you when it opens.",
        },
        port25: {
          q: "Is outbound port 25 open for sending email?",
          a: "No. Outbound port 25 is closed. To send email, use the API of an email service or another port.",
        },
        support: {
          q: "Where do I get help?",
          a: "Contact us from the support page. When you are signed in you can also write to us from the panel.",
        },
        bdt: {
          q: "Are prices in taka?",
          a: "Yes. All prices and payments are in Bangladeshi taka (BDT).",
        },
      },
    },
    support: {
      heading: "Support and contact",
      lead: "MeghVPS sells, bills and supports the service. Reach us in the ways below.",
      signedInTitle: "If you have an account",
      signedInText:
        "Sign in to the panel and send a request from the support page. We then already have your servers and orders at hand.",
      signedInCta: "Go to the panel",
      phoneTitle: "Phone",
      phonePending: "The support phone number will be added here soon.",
      emailTitle: "Email",
      emailPending: "The support email address will be added here soon.",
      faqTitle: "Look at the questions first",
      faqText: "Most answers are there.",
      faqCta: "Questions",
      form: {
        title: "Write to us",
        lead: "No account needed. We answer by email. Do not write passwords, card numbers or ID document numbers here.",
        email: "Your email",
        emailPlaceholder: "name@example.com",
        name: "Your name (optional)",
        category: "What is it about",
        subject: "Subject",
        message: "Your message",
        honeypot: "Leave this field empty",
        submit: "Send",
        doneTitle: "Thank you",
        done: "We received your message and will answer by email.",
        categories: {
          billing: "Billing and payments",
          technical: "Technical help",
          kyc: "Identity check",
          domain: "Domains",
          abuse: "Report abuse",
          other: "Something else",
        },
        error: {
          invalid: "Check the marked fields and try again.",
          rate_limited: "Too many tries. Try again in a little while.",
          unavailable: "We cannot save this now. Try again in a little while.",
        },
        fieldInvalid: "Check this field.",
        reference: "Quote this code if you write to us again: {ref}",
      },
    },
    legal: {
      heading: "Legal documents",
      sidebarTitle: "Documents",
      sidebarLabel: "List of legal documents",
      draftTitle: "Draft, not final legal text yet",
      draftText:
        "The text on this page is a temporary placeholder. It does not count as terms until wording approved by the legal adviser is in place.",
      version: "Version: draft 0",
      docs: {
        terms: {
          title: "Terms of use",
          sections: {
            scope: "Scope: what MeghVPS provides and who does what. [legal text pending]",
            payment: "Money, wallet and renewal. [legal text pending]",
            suspension: "The right to suspend and end the service. [legal text pending]",
          },
        },
        "acceptable-use": {
          title: "Acceptable use policy",
          sections: {
            aws: "The AWS Acceptable Use Policy also binds customers. [legal text pending]",
            mining: "Cryptocurrency mining is not allowed. [legal text pending]",
            transfer:
              "Rules on using Amazon Lightsail to avoid the data fees of other AWS services, on video streaming or very high request volume through CDN, and on outbound port 25. [legal text pending]",
            suspend:
              "MeghVPS may suspend a resource at once on a breach or an AWS notice. [legal text pending]",
          },
        },
        privacy: {
          title: "Privacy policy",
          sections: {
            collect: "Which data we collect and why. [legal text pending]",
            storage:
              "Where data is kept: account and identity documents in AWS Singapore. [legal text pending]",
            rights: "Your rights and how to reach us. [legal text pending]",
          },
        },
        refund: {
          title: "Refund policy",
          sections: {
            wallet: "Refund of wallet money. [legal text and rules pending]",
            service: "Refund of a service price. [legal text and rules pending]",
          },
        },
      },
    },
    system: {
      maintenanceTitle: "Under maintenance",
      maintenanceText: "We are improving the service and will be back soon.",
      errorTitle: "Something went wrong",
      errorText: "The page could not be shown. Try again.",
      retry: "Try again",
      home: "Go home",
      contactUs: "Contact us",
    },
  },
};
