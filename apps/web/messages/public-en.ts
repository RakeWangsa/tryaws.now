import { legalDocsEn } from "./legal-en.ts";
import type { publicBn } from "./public-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

// The legal documents are DRAFTS in `legal-en.ts` (WPU-Z7) that wait for the owner's approval.
export const publicEn: Same<typeof publicBn> = {
  Public: {
    crumb: { home: "Home" },
    entity: {
      statement:
        "TryAWS.now is a prepaid cloud panel for people and businesses in Bangladesh. You buy Cloud Servers, built on Amazon Lightsail, that run in the AWS Region Singapore or Mumbai. Prices are in US dollars and include VAT and fees; you pay in taka from a wallet that you top up with EPS. TryAWS.now sells, bills and supports the service.",
    },
    updated: { label: "Last updated: <time>{date}</time>" },
    meta: {
      home: {
        title: "TryAWS.now: Cloud Server, built on Amazon Lightsail",
        description:
          "Prepaid cloud panel for Bangladesh. Cloud Server, built on Amazon Lightsail. Prices in US dollars, wallet in taka, top up with EPS.",
      },
      pricing: {
        title: "Pricing: Cloud Server, built on Amazon Lightsail",
        description:
          "Cloud Server plans with prices in US dollars for 30 days. Prices include VAT and fees. Built on Amazon Lightsail.",
      },
      cloudServers: {
        title: "Cloud Server, built on Amazon Lightsail",
        description:
          "Cloud servers that run in the AWS Region Singapore or Mumbai. Plans, specifications and prices in US dollars. Built on Amazon Lightsail.",
      },
      help: {
        title: "Help and frequently asked questions",
        description:
          "Answers about TryAWS.now and Amazon Lightsail: AWS, billing, support and where your data is.",
      },
      support: {
        title: "Support and contact",
        description:
          "How to get support from TryAWS.now: support requests in the panel, or the form on the support page without an account.",
      },
      legal: {
        title: "Legal documents",
        description: "TryAWS.now terms, privacy, acceptable use and refund policy.",
        descriptionOf:
          "{title} of TryAWS.now, the prepaid cloud panel for Bangladesh. A draft that awaits final approval.",
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
      // WPU-Y4 wording (approved by the owner on 2026-11-13): USD, taka at checkout, Amazon Lightsail.
      priceNote:
        "Prices are in US dollars (USD), for 30 days, and include VAT and fees. The amount in taka is worked out at checkout with the exchange rate of the day, and you see it before you confirm. 100% AWS infrastructure. Built on Amazon Lightsail.",
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
      plansTitle: "Popular Cloud Server plans",
      plansLead:
        "The lowest priced open plans right now. Every price comes straight from the price list.",
      whyTitle: "Why TryAWS.now",
      why: {
        aws: {
          title: "100% AWS infrastructure",
          text: "Every server is an Amazon Lightsail resource that runs in the AWS Region you choose.",
        },
        bdt: {
          title: "Wallet in taka, top up first",
          text: "Add money to your wallet with EPS, then buy from it.",
        },
        panel: {
          title: "One panel, no separate AWS account",
          text: "Create, start, stop and back up servers from the TryAWS.now panel. You do not need the AWS console.",
        },
        support: {
          title: "TryAWS.now bills and supports you",
          text: "TryAWS.now sells, bills and supports the service. Open a support request when you need help.",
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
      lead: "Cloud Server, built on Amazon Lightsail. Every price is for 30 days, in US dollars.",
      answer:
        "Every Cloud Server price on TryAWS.now is in US dollars for 30 days and already includes VAT and fees. At checkout you see the exchange rate of the day and the exact amount in taka before you confirm, and exactly that amount is taken from your wallet, which you top up with EPS.",
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
      answer:
        "A Cloud Server on TryAWS.now is an Amazon Lightsail instance that runs in the AWS Region Singapore or Mumbai. You pick a plan and a location, see the price in US dollars for 30 days with VAT and fees included, pay in taka from your wallet, and manage the server from the TryAWS.now panel.",
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
      lead: "The questions we hear most about TryAWS.now and Amazon Lightsail.",
      answer:
        "TryAWS.now sells Cloud Servers, built on Amazon Lightsail, in the AWS Region Singapore or Mumbai. You top up a wallet in taka with EPS and buy from it; prices are in US dollars, include VAT and fees, and are converted to taka at checkout. You complete an identity check once, and you get support through support requests.",
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
          a: "No. You run everything from the TryAWS.now panel. You do not need a separate AWS account or the AWS console.",
        },
        billing: {
          q: "Who bills me and who supports me?",
          a: "TryAWS.now. We sell and bill the service, and we support you through support requests in the panel. There is no support phone line.",
        },
        dataLocation: {
          q: "Where is my data?",
          a: "Servers, databases, disks and buckets are in the AWS Region you choose. CDN copies are at AWS edge locations worldwide. DNS is a global service. Your account and identity documents are kept in AWS Singapore.",
        },
        payment: {
          q: "How do I pay?",
          a: "Top up your wallet with EPS first, then buy servers from the wallet. The wallet and all payments are in taka; the taka amount of an order is shown at checkout.",
        },
        priceIncludes: {
          q: "What does the price include?",
          a: "A displayed price is in US dollars, for 30 days, and includes VAT and fees. At checkout you see the exchange rate of the day and the amount in taka before you confirm, and you are charged exactly that amount.",
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
          a: "Open a support request in the panel and read our answers there. Without an account, use the form on the support page and we answer by email. There is no support phone line or support email address.",
        },
        bdt: {
          q: "Are prices in taka?",
          a: "Prices are shown in US dollars. Your wallet, top-ups and invoices are in Bangladeshi taka (BDT); the taka amount of an order is worked out at checkout with the exchange rate of the day.",
        },
        vatInvoice: {
          q: "Do I get a VAT invoice?",
          a: "Yes. For each purchase and renewal TiCON System Limited gives you a tax invoice (Mushak-6.3) in taka. Every price includes the taxes and fees that apply, among them the Bangladesh VAT of 5%, and the invoice shows each tax and fee on its own line. A VAT-registered business can have its BIN printed on the invoice.",
        },
        refunds: {
          q: "Can I get a refund?",
          a: "If a resource cannot be created after you paid, the full amount goes back to your wallet automatically. When we cancel a purchase or a renewal, the whole amount goes back to your wallet and you get a credit note in taka. For anything else, open a billing support request; the refund policy has the details.",
        },
      },
    },
    support: {
      heading: "Support and contact",
      lead: "TryAWS.now gives support through support requests only, and our support team answers every request in writing. With an account, open a request in the panel and follow the answers there. Without an account, use the form on the support page and we answer by email. There is no support phone line and no support email address.",
      customerTitle: "If you have an account",
      customerText:
        "Open a support request in the panel and follow it there: read our answers and reply in the same place. If you are not signed in, you sign in first.",
      newCta: "Open a support request",
      requestsCta: "My support requests",
      visitorTitle: "If you have no account",
      visitorText:
        "Write to us with the form below. We send our answer to the email address you give.",
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
      // WPU-Z7: shown until the owner approves the exact texts (manual proof wp9-t5-legal-final).
      draftTitle: "Draft — awaiting final approval",
      draftText:
        "This text is a draft. It takes effect only after its final approval and may change until then. The points in square brackets are not decided yet.",
      version: "Version: draft 1, 13 November 2026",
      docs: legalDocsEn,
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
