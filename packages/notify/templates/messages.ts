import type { TemplateId } from "../queue/types";

// The texts of the 22 messages, Bengali first. Two typed catalogs: a missing key is a type error,
// and test/templates.test.ts checks every placeholder, the SMS length and the forbidden forms
// (16.16: "AWS Lightsail"). Placeholders are plain `{name}`. Wording: TiCON Cloud sells, bills and
// supports; AWS is named only in the footer statements of 16.13, which are used unchanged.

export interface TemplateText {
  readonly subject: string;
  readonly headline: string;
  readonly body: readonly string[];
  // Present for every template that can send an SMS. No link: operators filter an unregistered
  // A2P SMS with a link. English is ASCII (BDT, not the taka sign) so that it stays GSM-7.
  readonly sms?: string;
  // Small named sentences the template picks from, for example the failure kind.
  readonly extra?: Readonly<Record<string, string>>;
}
export type Catalog = Readonly<Record<TemplateId, TemplateText>>;

export interface SharedText {
  readonly wordmark: string;
  readonly awsShort: string;
  readonly trademark: string;
  readonly address: string;
  readonly footerNote: string;
  readonly cta: Readonly<Record<string, string>>;
  readonly products: Readonly<Record<string, string>>;
  readonly regions: Readonly<Record<string, string>>;
}

// 16.13 "used unchanged": the trademark line is English in both locales.
const TRADEMARK =
  "Amazon Web Services, AWS, Amazon Lightsail and Amazon Route 53 are trademarks of Amazon.com, Inc. or its affiliates.";
const ADDRESS =
  "TiCON System Limited, Level 6, House of Veritas, 8 Gareeb-e-Newaz Avenue, Sector-13, Uttara, Dhaka-1230";

export const SHARED: Readonly<Record<"bn" | "en", SharedText>> = {
  bn: {
    wordmark: "TiCON Cloud",
    awsShort: "১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।",
    trademark: TRADEMARK,
    address: ADDRESS,
    footerNote: "এই বার্তাটি আপনার TiCON Cloud অ্যাকাউন্টের জন্য পাঠানো হয়েছে।",
    cta: {
      open_panel: "প্যানেল খুলুন",
      kyc: "KYC দেখুন",
      create_server: "সার্ভার তৈরি করুন",
      view_wallet: "ওয়ালেট দেখুন",
      view_invoice: "ইনভয়েস দেখুন",
      view_order: "অর্ডার দেখুন",
      view_resource: "রিসোর্স দেখুন",
      renew: "রিনিউ করুন",
      restore: "রিস্টোর করুন",
      top_up: "টপ আপ করুন",
      security: "নিরাপত্তা সেটিং",
      open_domain: "ডোমেইন দেখুন",
    },
    products: {
      instance: "ক্লাউড সার্ভার",
      database: "ম্যানেজড ডেটাবেস",
      disk: "ব্লক স্টোরেজ",
      bucket: "অবজেক্ট স্টোরেজ",
      load_balancer: "লোড ব্যালান্সার",
      container_service: "কন্টেইনার সার্ভিস",
      cdn: "সিডিএন",
      static_ip: "স্ট্যাটিক আইপি",
      snapshot: "ব্যাকআপ",
      dns_zone: "ডিএনএস",
      domain: "ডোমেইন",
    },
    regions: {
      "ap-southeast-1": "এশিয়া প্যাসিফিক (সিঙ্গাপুর)",
      "ap-south-1": "এশিয়া প্যাসিফিক (মুম্বাই)",
      "us-east-1": "ইউএস ইস্ট (ভার্জিনিয়া)",
    },
  },
  en: {
    wordmark: "TiCON Cloud",
    awsShort: "100% AWS infrastructure. Built on Amazon Lightsail.",
    trademark: TRADEMARK,
    address: ADDRESS,
    footerNote: "This message was sent for your TiCON Cloud account.",
    cta: {
      open_panel: "Open the panel",
      kyc: "View KYC",
      create_server: "Create a server",
      view_wallet: "View wallet",
      view_invoice: "View invoice",
      view_order: "View order",
      view_resource: "View resource",
      renew: "Renew now",
      restore: "Restore",
      top_up: "Top up",
      security: "Security settings",
      open_domain: "View domain",
    },
    products: {
      instance: "Cloud Server",
      database: "Managed Database",
      disk: "Block Storage",
      bucket: "Object Storage",
      load_balancer: "Load Balancer",
      container_service: "Container Service",
      cdn: "CDN",
      static_ip: "Static IP",
      snapshot: "Backup",
      dns_zone: "DNS",
      domain: "Domain",
    },
    regions: {
      "ap-southeast-1": "Asia Pacific (Singapore)",
      "ap-south-1": "Asia Pacific (Mumbai)",
      "us-east-1": "US East (N. Virginia)",
    },
  },
};

const SECURITY_BN = (what: string, sms: string): TemplateText => ({
  subject: `নিরাপত্তা সতর্কতা: ${what}`,
  headline: what,
  body: [
    `{time}-এ আপনার অ্যাকাউন্টে ${what} হয়েছে{where}।`,
    "এটি আপনি না করে থাকলে এখনই পাসওয়ার্ড বদলান এবং আমাদের সাপোর্টে জানান।",
  ],
  sms,
  extra: { from_ip: " (আইপি {ip} থেকে)" },
});

export const BN: Catalog = {
  welcome: {
    subject: "TiCON Cloud-এ স্বাগতম",
    headline: "স্বাগতম",
    body: [
      "আপনার অ্যাকাউন্ট প্রস্তুত।",
      "প্যানেলে ঢুকে ফোন যাচাই ও KYC সম্পন্ন করুন, তারপর প্রথম সার্ভার তৈরি করুন।",
    ],
  },
  kyc_received: {
    subject: "আপনার KYC জমা পেয়েছি",
    headline: "KYC জমা হয়েছে",
    body: ["আপনার KYC তথ্য আমরা পেয়েছি। যাচাই শেষ হলে আপনাকে জানানো হবে।"],
  },
  kyc_approved: {
    subject: "আপনার KYC অনুমোদিত হয়েছে",
    headline: "KYC অনুমোদিত",
    body: ["আপনার KYC যাচাই সম্পন্ন হয়েছে। এখন আপনি রিসোর্স কিনতে পারবেন।"],
    sms: "TiCON Cloud: আপনার KYC অনুমোদিত হয়েছে। এখন রিসোর্স কিনতে পারবেন।",
  },
  kyc_rejected: {
    subject: "আপনার KYC গ্রহণ করা যায়নি",
    headline: "KYC গ্রহণ করা যায়নি",
    body: ["কারণ: {reason}", "তথ্য ঠিক করে আবার জমা দিন।"],
  },
  topup_receipt: {
    subject: "টপ আপ রসিদ",
    headline: "টপ আপ সফল",
    body: ["{date} তারিখে আপনার ওয়ালেটে {amount} যোগ হয়েছে।", "বর্তমান ব্যালেন্স: {balance}।"],
  },
  order_paid: {
    subject: "ইনভয়েস {invoice}",
    headline: "পেমেন্ট সম্পন্ন",
    body: [
      "আপনার {product} অর্ডারের মূল্য {total} ওয়ালেট থেকে পরিশোধ হয়েছে।",
      "ইনভয়েস নম্বর: {invoice}। বর্তমান ব্যালেন্স: {balance}।",
    ],
  },
  order_failed_refunded: {
    subject: "অর্ডার সম্পন্ন করা যায়নি, টাকা ফেরত দেওয়া হয়েছে",
    headline: "অর্ডার ব্যর্থ, টাকা ফেরত",
    body: [
      "আপনার {product} অর্ডারটি সম্পন্ন করা যায়নি: {failure}",
      "{refund} আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে। বর্তমান ব্যালেন্স: {balance}।",
    ],
    extra: {
      create_failed: "রিসোর্স তৈরি করা যায়নি।",
      capacity_full: "এই লোকেশনে এখন ক্ষমতা নেই।",
    },
  },
  resource_ready: {
    subject: "আপনার {product} প্রস্তুত",
    headline: "রিসোর্স প্রস্তুত",
    body: ["{name} ({product}) প্রস্তুত।", "লোকেশন: {region}", "ঠিকানা: {address}"],
    sms: "TiCON Cloud: আপনার {product} প্রস্তুত। ঠিকানা: {address}",
  },
  renewal_reminder: {
    subject: "{days} দিন পর রিনিউ",
    headline: "রিনিউয়ের অনুস্মারক",
    body: [
      "{name} এর মেয়াদ {date} তারিখে শেষ হবে ({days} দিন বাকি)।",
      "রিনিউয়ের পরিমাণ: {amount}। ওয়ালেট ব্যালেন্স: {balance}।",
      "{note}",
    ],
    sms: "TiCON Cloud: {name} কাল ({date}) শেষ হচ্ছে। রিনিউ {amount}, ব্যালেন্স {balance}।",
    extra: {
      auto_on: "স্বয়ংক্রিয় রিনিউ চালু আছে। ওয়ালেটে যথেষ্ট টাকা রাখুন।",
      auto_off: "স্বয়ংক্রিয় রিনিউ বন্ধ আছে। মেয়াদের মধ্যে নিজে রিনিউ করুন।",
    },
  },
  renewed: {
    subject: "রিনিউ সম্পন্ন, ইনভয়েস {invoice}",
    headline: "রিনিউ সম্পন্ন",
    body: [
      "{total} ওয়ালেট থেকে কেটে আপনার রিসোর্স রিনিউ হয়েছে। নতুন মেয়াদ: {date}।",
      "ইনভয়েস নম্বর: {invoice}। বর্তমান ব্যালেন্স: {balance}।",
    ],
  },
  grace_started: {
    subject: "রিনিউ বাকি: রিসোর্স স্থগিত",
    headline: "রিনিউ বাকি, রিসোর্স স্থগিত",
    body: [
      "{name} রিনিউ হয়নি, তাই স্থগিত করা হয়েছে।",
      "{until} পর্যন্ত রিনিউ করলে সব আগের মতো চলবে। এরপর রিসোর্স মুছে যাবে।",
      "রিনিউয়ের পরিমাণ: {amount}। ওয়ালেট ব্যালেন্স: {balance}।",
    ],
    sms: "TiCON Cloud: {name} স্থগিত। {until} এর মধ্যে রিনিউ ({amount}) না করলে মুছে যাবে।",
  },
  resource_destroyed: {
    subject: "রিসোর্স মুছে গেছে, {kept} রাখা আছে",
    headline: "রিসোর্স মুছে গেছে",
    body: [
      "{name} মুছে ফেলা হয়েছে। আপনার {kept} {until} পর্যন্ত রাখা হবে।",
      "এর মধ্যে রিস্টোর করতে পারবেন।",
    ],
    sms: "TiCON Cloud: {name} মুছে গেছে। {kept} {until} পর্যন্ত রিস্টোর করতে পারবেন।",
    extra: { backup: "ব্যাকআপ", settings: "সেটিং" },
  },
  backups_purged: {
    subject: "ব্যাকআপ মুছে ফেলা হয়েছে",
    headline: "ব্যাকআপ মুছে ফেলা হয়েছে",
    body: ["{name} এর রাখা {kept} {date} তারিখে মুছে ফেলা হয়েছে। এটি আর ফেরানো যাবে না।"],
    extra: { backup: "ব্যাকআপ", settings: "সেটিং" },
  },
  low_balance: {
    subject: "ওয়ালেট ব্যালেন্স কম",
    headline: "ব্যালেন্স কম",
    body: [
      "আগামী {windowDays} দিনে রিনিউয়ে {due} লাগবে, কিন্তু ওয়ালেটে আছে {balance}।",
      "রিসোর্স চালু রাখতে টপ আপ করুন।",
    ],
  },
  payment_expired: {
    subject: "পেমেন্টের সময় শেষ",
    headline: "পেমেন্টের সময় শেষ",
    body: [
      "{amount} এর পেমেন্টটি সম্পন্ন হয়নি এবং মেয়াদ শেষ হয়েছে। আপনার কোনো টাকা কাটা হয়নি।",
      "আবার চেষ্টা করুন।",
    ],
  },
  security_new_sign_in: SECURITY_BN(
    "নতুন সাইন-ইন",
    "TiCON Cloud: আপনার অ্যাকাউন্টে নতুন সাইন-ইন হয়েছে। আপনি না হলে এখনই পাসওয়ার্ড বদলান।",
  ),
  security_password_changed: SECURITY_BN(
    "পাসওয়ার্ড পরিবর্তন",
    "TiCON Cloud: আপনার পাসওয়ার্ড বদলানো হয়েছে। আপনি না হলে এখনই সাপোর্টে জানান।",
  ),
  security_totp_changed: SECURITY_BN(
    "TOTP সেটিং পরিবর্তন",
    "TiCON Cloud: আপনার TOTP সেটিং বদলানো হয়েছে। আপনি না হলে এখনই সাপোর্টে জানান।",
  ),
  security_email_changed: SECURITY_BN(
    "ইমেইল ঠিকানা পরিবর্তন",
    "TiCON Cloud: আপনার ইমেইল ঠিকানা বদলানো হয়েছে। আপনি না হলে এখনই সাপোর্টে জানান।",
  ),
  security_phone_changed: SECURITY_BN(
    "ফোন নম্বর পরিবর্তন",
    "TiCON Cloud: আপনার ফোন নম্বর বদলানো হয়েছে। আপনি না হলে এখনই সাপোর্টে জানান।",
  ),
  domain_contact_pending: {
    subject: "ডোমেইন {domain}: যোগাযোগ যাচাই বাকি",
    headline: "ডোমেইনের যোগাযোগ যাচাই বাকি",
    body: [
      "{domain} নিবন্ধনের জন্য আপনার ইমেইলে একটি যাচাই বার্তা পাঠানো হয়েছে।",
      "বার্তাটি নিশ্চিত না করলে ডোমেইনটি রেজিস্ট্রি স্থগিত করবে।",
    ],
  },
  domain_renewal_reminder: {
    subject: "ডোমেইন {domain}: {days} দিন পর মেয়াদ শেষ",
    headline: "ডোমেইন রিনিউয়ের অনুস্মারক",
    body: [
      "{domain} এর মেয়াদ {date} তারিখে শেষ হবে ({days} দিন বাকি)।",
      "রিনিউ না করলে ডোমেইনটি হারাতে পারেন।",
    ],
    sms: "TiCON Cloud: {domain} এর মেয়াদ {days} দিন পর ({date}) শেষ। রিনিউ করুন।",
  },
};

const SECURITY_EN = (what: string, subject: string, sms: string): TemplateText => ({
  subject: `Security alert: ${subject}`,
  headline: subject,
  body: [
    `${what} on {time}{where}.`,
    "If this was not you, change your password now and tell our support.",
  ],
  sms,
  extra: { from_ip: " from IP {ip}" },
});

export const EN: Catalog = {
  welcome: {
    subject: "Welcome to TiCON Cloud",
    headline: "Welcome",
    body: [
      "Your account is ready.",
      "Open the panel, verify your phone and finish KYC, then create your first server.",
    ],
  },
  kyc_received: {
    subject: "We received your KYC",
    headline: "KYC received",
    body: ["We received your KYC details. We will tell you when the check is done."],
  },
  kyc_approved: {
    subject: "Your KYC is approved",
    headline: "KYC approved",
    body: ["Your KYC check is complete. You can now buy resources."],
    sms: "TiCON Cloud: your KYC is approved. You can now buy resources.",
  },
  kyc_rejected: {
    subject: "Your KYC could not be accepted",
    headline: "KYC not accepted",
    body: ["Reason: {reason}", "Correct the details and submit again."],
  },
  topup_receipt: {
    subject: "Top-up receipt",
    headline: "Top-up received",
    body: ["{amount} was added to your wallet on {date}.", "Current balance: {balance}."],
  },
  order_paid: {
    subject: "Invoice {invoice}",
    headline: "Payment complete",
    body: [
      "{total} was paid from your wallet for your {product} order.",
      "Invoice number: {invoice}. Current balance: {balance}.",
    ],
  },
  order_failed_refunded: {
    subject: "Order failed, refund issued",
    headline: "Order failed, refunded",
    body: [
      "Your {product} order could not be completed: {failure}",
      "{refund} was returned to your wallet. Current balance: {balance}.",
    ],
    extra: {
      create_failed: "the resource could not be created.",
      capacity_full: "there is no capacity in this location right now.",
    },
  },
  resource_ready: {
    subject: "Your {product} is ready",
    headline: "Resource ready",
    body: ["{name} ({product}) is ready.", "Location: {region}", "Address: {address}"],
    sms: "TiCON Cloud: your {product} is ready. Address: {address}",
  },
  renewal_reminder: {
    subject: "Renews in {days} days",
    headline: "Renewal reminder",
    body: [
      "{name} ends on {date} ({days} days left).",
      "Renewal amount: {amount}. Wallet balance: {balance}.",
      "{note}",
    ],
    sms: "TiCON Cloud: {name} ends tomorrow ({date}). Renewal {amount}, balance {balance}.",
    extra: {
      auto_on: "Automatic renewal is on. Keep enough money in your wallet.",
      auto_off: "Automatic renewal is off. Renew yourself before it ends.",
    },
  },
  renewed: {
    subject: "Renewed, invoice {invoice}",
    headline: "Renewal complete",
    body: [
      "{total} was taken from your wallet to renew your resource. New end date: {date}.",
      "Invoice number: {invoice}. Current balance: {balance}.",
    ],
  },
  grace_started: {
    subject: "Renewal due: resource suspended",
    headline: "Renewal due, resource suspended",
    body: [
      "{name} was not renewed, so it is suspended.",
      "Renew by {until} and everything runs as before. After that the resource is deleted.",
      "Renewal amount: {amount}. Wallet balance: {balance}.",
    ],
    sms: "TiCON Cloud: {name} is suspended. Renew ({amount}) by {until} or it is deleted.",
  },
  resource_destroyed: {
    subject: "Resource deleted, {kept} kept",
    headline: "Resource deleted",
    body: [
      "{name} was deleted. Your {kept} is kept until {until}.",
      "You can restore it until then.",
    ],
    sms: "TiCON Cloud: {name} was deleted. You can restore the {kept} until {until}.",
    extra: { backup: "backup", settings: "settings" },
  },
  backups_purged: {
    subject: "Backups deleted",
    headline: "Backups deleted",
    body: ["The {kept} kept for {name} was deleted on {date}. It cannot be restored."],
    extra: { backup: "backup", settings: "settings" },
  },
  low_balance: {
    subject: "Low wallet balance",
    headline: "Low balance",
    body: [
      "Renewals in the next {windowDays} days need {due}, but your wallet holds {balance}.",
      "Top up to keep your resources running.",
    ],
  },
  payment_expired: {
    subject: "Payment expired",
    headline: "Payment expired",
    body: [
      "The payment of {amount} was not completed and has expired. You were not charged.",
      "Try again.",
    ],
  },
  security_new_sign_in: SECURITY_EN(
    "A new sign-in to your account was seen",
    "new sign-in",
    "TiCON Cloud: a new sign-in to your account. If it was not you, change your password now.",
  ),
  security_password_changed: SECURITY_EN(
    "Your password was changed",
    "password changed",
    "TiCON Cloud: your password was changed. If it was not you, tell support now.",
  ),
  security_totp_changed: SECURITY_EN(
    "Your TOTP setting was changed",
    "TOTP changed",
    "TiCON Cloud: your TOTP setting was changed. If it was not you, tell support now.",
  ),
  security_email_changed: SECURITY_EN(
    "Your email address was changed",
    "email changed",
    "TiCON Cloud: your email address was changed. If it was not you, tell support now.",
  ),
  security_phone_changed: SECURITY_EN(
    "Your phone number was changed",
    "phone changed",
    "TiCON Cloud: your phone number was changed. If it was not you, tell support now.",
  ),
  domain_contact_pending: {
    subject: "Domain {domain}: contact verification pending",
    headline: "Domain contact verification pending",
    body: [
      "A verification message was sent to your email for the registration of {domain}.",
      "If you do not confirm it, the registry suspends the domain.",
    ],
  },
  domain_renewal_reminder: {
    subject: "Domain {domain}: ends in {days} days",
    headline: "Domain renewal reminder",
    body: [
      "{domain} ends on {date} ({days} days left).",
      "If you do not renew, you can lose the domain.",
    ],
    sms: "TiCON Cloud: {domain} ends in {days} days ({date}). Renew it.",
  },
};
