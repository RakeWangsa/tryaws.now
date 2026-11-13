import type { legalDocsBn } from "./legal-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

// `Public.legal.docs` in English: the DRAFTS of WPU-Z7 (see legal-bn.ts). A missing fact is a note
// "[To be decided: …]"; the owner approves these exact texts (manual proof wp9-t5-legal-final).
export const legalDocsEn: Same<typeof legalDocsBn> = {
  terms: {
    title: "Terms of service",
    sections: {
      provider: {
        title: "1. Who provides the service",
        p1: "{brand} is a brand of {company}, {address}. In these terms, “{brand}”, “we” and “us” mean {company}.",
        p2: "These terms apply to your {brand} account and to every resource you buy. You accept them, together with the acceptable use policy and the privacy policy, when you open your account, and we record the version you accepted.",
      },
      service: {
        title: "2. The service",
        p1: "{brand} is a prepaid, self-service cloud panel. Every server, database, disk, bucket, load balancer and container service you buy is an Amazon Lightsail resource in the AWS Region you choose. CDN, DNS and domains use Amazon Lightsail CDN distributions and Amazon Route 53, which are global AWS services.",
        p2: "You do not get an AWS account, the AWS console or access to the AWS API. You manage your resources in the {brand} panel. {brand} sells, bills and supports the service.",
        p3: "We open products step by step. A product that is not open yet cannot be bought; its page says so.",
      },
      account: {
        title: "3. Your account",
        p1: "To open an account you give your full name, your email address, a Bangladesh mobile number and a password, and you choose the account type. A business also gives its company name.",
        p2: "You confirm your email address and your mobile number with the codes we send you. Keep your password secret; we never send your password by email.",
        p3: "[To be decided: who may open an account, for example a minimum age, and whether people and businesses outside Bangladesh may.]",
      },
      identity: {
        title: "4. Identity check",
        p1: "Before your first purchase you complete an identity check once. You give your identity details and upload an identity document.",
        p2: "Our staff review the check and tell you the result by email. If the check is rejected, the email gives the reason.",
      },
      wallet: {
        title: "5. Wallet and payments",
        p1: "{brand} is prepaid. You add money to your wallet in taka (BDT) through EPS, and every purchase, renewal and charge by use is paid from the wallet. There is no credit and no bill to pay later.",
        p2: "We add a top-up to your wallet only after EPS has confirmed the same payment and the same amount to us directly. The smallest and the largest top-up amounts are shown when you top up.",
        p3: "If EPS reports a payment as successful but the amount does not match, we do not add it to your wallet. Our finance staff check it, and the panel shows the payment as pending with a note to contact support.",
        p4: "For a top-up you get a payment receipt. A tax invoice is issued for each purchase and each renewal.",
      },
      prices: {
        title: "6. Prices and checkout",
        p1: "Our price list is in US dollars (USD), for 30 days. Every price includes the taxes and fees that apply, among them the Bangladesh VAT of 5%. Your invoice shows each tax and fee on its own line.",
        p2: "When you buy, we convert the price to taka with the exchange rate of the day that {brand} sets. Before you confirm, the checkout shows the amount in taka and the rate used, with the date the rate was set. Your wallet is charged exactly the amount shown.",
        p3: "If the price or the rate changes before you confirm, the checkout shows the new amount and asks you again. A later change of a price or a rate never changes an order you have placed or a period you have paid for.",
        p4: "In the panel every amount is in taka.",
      },
      orders: {
        title: "7. Orders",
        p1: "Each order buys one resource and is paid from your wallet. We create the resource after the payment.",
        p2: "If the resource cannot be created, the full amount goes back to your wallet automatically, and we tell you by email.",
      },
      renewal: {
        title: "8. Periods and renewal",
        p1: "A resource is paid for 30 days at a time, in advance. Auto-renew is on for every new purchase; you can switch it off for each resource in the panel.",
        p2: "At the end of a period, if auto-renew is on and your wallet holds enough, we renew the resource for another 30 days and issue an invoice. A renewal is charged at the price and the exchange rate of the renewal day.",
        p3: "We remind you by email 7, 3 and 1 day before a period ends, with the renewal amount at the rate of that day and your wallet balance, and by SMS 1 day before.",
        p4: "If auto-renew is off, renew the resource in the panel before the period ends.",
      },
      notRenewed: {
        title: "9. When a period is not renewed",
        p1: "If a period ends and is not renewed, the resource is suspended. Its data is kept.",
        p2: "If you renew within 48 hours, the resource starts again and the new period starts where the old one ended. With auto-renew on, this happens by itself as soon as your wallet holds enough.",
        p3: "After 48 hours the resource is deleted; where the product has backups, a final backup is made before it is deleted. For 14 days after the deletion you can pay to restore the resource from that backup; the new period then starts when it is restored.",
        p4: "A load balancer, container service, CDN or DNS zone has no final backup: its settings are kept, and it is created again from them with a new address.",
        p5: "After those 14 days the backup or the kept settings are deleted for good.",
      },
      usage: {
        title: "10. Charges by use and unpaid charges",
        p1: "Some items are charged by use from your wallet, for example the storage of the backups you keep, by the day, and a static IP that is not attached to a server, by the hour after the first hour.",
        p2: "Each plan includes an amount of data transfer for its period, which can differ by location. We tell you when 80% and when 100% of it is used. [To be decided: the handling of data transfer above the included amount is not available yet. The rule planned for it: above 100%, 50 GB packs are bought from your wallet if you have switched this on; otherwise the public ports of the resource are closed until the next period.]",
        p3: "If a charge by use cannot be taken from your wallet, we try again every day. If it is still unpaid after 1 day, the resource is suspended. While the charge is unpaid we email you every day, with the days left before the deletion.",
        p4: "After 7 days unpaid we request the deletion of the resource. Where the product has backups, a final backup is made before anything is deleted. If you top up before the deletion, the charge is taken and the resource starts again.",
      },
      suspension: {
        title: "11. Suspension and deletion",
        p1: "We may suspend a resource at once if it breaks the acceptable use policy, or if AWS sends us a notice about it. A resource we suspend for this reason stays suspended until our staff lift the suspension; a payment does not start it again.",
        p2: "Up to and including 1 December 2026, every deletion of a resource waits for the approval of a member of our staff, whether you ask for it or it follows from these terms.",
      },
      invoices: {
        title: "12. Invoices",
        p1: "For each purchase and renewal you get a tax invoice (Mushak-6.3) in taka, issued by {company}. Invoices show no amounts in US dollars.",
        p2: "When we cancel a purchase or a renewal and return the whole amount to your wallet, you get a credit note in taka for its invoice. You find your invoices, receipts and credit notes in the panel, and we email each invoice.",
        p3: "[To be decided: whether and how charges by use get a tax invoice, and a credit note when one is cancelled.]",
      },
      support: {
        title: "13. Support",
        p1: "We give support through support requests. Open a request in the panel and follow our answers there. Without an account, use the form on the support page; we answer by email.",
        p2: "There is no support phone line and no support email address.",
      },
      liability: {
        title: "14. Liability",
        p1: "[To be decided: the service levels, the compensation if the service fails, and the limits of our liability.]",
      },
      changes: {
        title: "15. Changes to these terms",
        p1: "The version of these terms is shown above. [To be decided: how and how early we tell you about a change, and how you accept it.]",
      },
      law: {
        title: "16. Governing law and disputes",
        p1: "[To be decided: the law that governs these terms and the courts that hear disputes.]",
      },
    },
  },
  "acceptable-use": {
    title: "Acceptable use policy",
    sections: {
      scope: {
        title: "1. Why these rules apply",
        p1: "These rules apply to everything you run, store or send with a {brand} resource.",
        p2: "You use these resources as an end user of AWS services, so the AWS rules for end users bind you too. The rules below pass them on, together with the rules of {brand}.",
      },
      aws: {
        title: "2. The AWS Acceptable Use Policy",
        p1: "You must follow the AWS Acceptable Use Policy, as AWS publishes it.",
      },
      mining: {
        title: "3. No cryptocurrency mining",
        p1: "Do not mine cryptocurrency on any resource (AWS Service Terms, section 1.25).",
      },
      transfer: {
        title: "4. No use to avoid data fees",
        p1: "Do not use an Amazon Lightsail resource to avoid the data fees of other AWS services (AWS Service Terms, section 51.3).",
      },
      cdn: {
        title: "5. Limits of the CDN",
        p1: "Do not use the CDN for a workload with a high number of requests per second or a large amount of video streaming (Amazon Lightsail FAQ).",
      },
      email: {
        title: "6. Sending email",
        p1: "Outbound port 25 is closed. To send email, use the API of an email service or another port.",
      },
      suspend: {
        title: "7. Suspension",
        p1: "If you break these rules, or if AWS sends us a notice about a resource, we may suspend the resource at once (AWS Customer Agreement, section 2.5).",
        p2: "A resource we suspend for this reason stays suspended until our staff lift the suspension; a payment does not start it again.",
      },
      report: {
        title: "8. Reporting abuse",
        p1: "To report abuse of a {brand} resource, use the form on the support page and choose “Report abuse”.",
      },
      more: {
        title: "9. Other rules",
        p1: "[To be decided: rules of {brand} beyond the AWS rules above, and what happens to an account after repeated breaches.]",
      },
    },
  },
  privacy: {
    title: "Privacy policy",
    sections: {
      controller: {
        title: "1. Who is responsible",
        p1: "{company}, {address}, is responsible for the personal data that {brand} processes.",
      },
      collect: {
        title: "2. What we collect",
        p1: "Account: your full name, email address, Bangladesh mobile number, password and account type, and the company name of a business.",
        p2: "Identity check: the identity details you give and the identity document you upload.",
        p3: "Payments and billing: your top-ups and their payment references, your orders, wallet entries, invoices, receipts and credit notes, and the billing details you choose to give for your invoices (the name and address on the invoice, and the BIN of a VAT-registered business). You enter your payment details on the payment page of EPS, not on {brand}.",
        p4: "Your resources: their settings, their state, the actions you start and the usage we measure for billing, such as data transfer.",
        p5: "Support and notices: what you write in support requests and in the support form, and the email address you leave to hear when a product opens.",
        p6: "Security: the IP address of your requests, which we use to limit repeated attempts, and the sign-in events we need to warn you about a new sign-in.",
      },
      why: {
        title: "3. Why we use it",
        p1: "To create and run your account and your resources, and to take payments into your wallet and charges from it.",
        p2: "To complete the identity check before your first purchase.",
        p3: "To issue tax invoices (Mushak-6.3) and credit notes.",
        p4: "To send the emails and SMS of the service: codes, receipts, invoices, reminders, notices about your resources and security alerts.",
        p5: "To answer your support requests and to protect the service against abuse.",
      },
      storage: {
        title: "4. Where your data is kept",
        // The answer of the FAQ (16.8), word for word: public-messages.test.ts compares the two.
        p1: "Servers, databases, disks and buckets are in the AWS Region you choose. CDN copies are at AWS edge locations worldwide. DNS is a global service. Your account and identity documents are kept in AWS Singapore.",
      },
      share: {
        title: "5. Who receives your data",
        p1: "AWS runs the infrastructure on which {brand} and your resources run. EPS processes your payments. Our email and SMS providers deliver the messages we send you.",
        p2: "Our staff see your data in their work: support, the identity check, finance and operations.",
        p3: "[To be decided: whether and when we give data to authorities, and any other recipients.]",
      },
      security: {
        title: "6. How we protect it",
        p1: "Our database cannot be reached from the internet, and every connection to it is encrypted.",
        p2: "Our staff work in a separate admin app that needs a two-step sign-in and opens only from approved network addresses. Every staff action is recorded with who did it, why, from where and on what.",
        p3: "Our logs never hold passwords, secret keys, identity document numbers, full phone numbers or email addresses.",
      },
      cookies: {
        title: "7. Cookies and scripts",
        p1: "The site uses only the cookies it needs to work, such as the cookie that keeps you signed in. It loads no analytics, advertising or chat scripts, and nothing from other websites.",
      },
      retention: {
        title: "8. How long we keep it",
        p1: "[To be decided: how long we keep account data, identity documents, invoices and support requests, and what happens to them when an account is closed.]",
      },
      rights: {
        title: "9. Your rights and how to reach us",
        p1: "You can see and change your profile and your billing details in the panel.",
        p2: "[To be decided: the data protection rights that apply by law; how you ask for a copy of your data, a correction or the deletion of your data (proposed: a support request in the panel, or the form on the support page without an account); and how fast we answer a request.]",
      },
    },
  },
  refund: {
    title: "Refund policy",
    sections: {
      wallet: {
        title: "1. Your wallet",
        p1: "{brand} is prepaid. The money you add is kept in your wallet in taka (BDT), and purchases, renewals and charges by use are paid from the wallet.",
        p2: "Refunds and credit notes are in taka, like the wallet and the invoices.",
      },
      failed: {
        title: "2. When an order fails",
        p1: "If a resource cannot be created after you paid for it, the full amount goes back to your wallet automatically. The order page shows the refund, and we email you what failed, the amount refunded and your new wallet balance.",
      },
      period: {
        title: "3. Periods already paid",
        p1: "A 30-day period is charged in full when it starts. [To be decided: whether the unused days of a period are refunded when you delete a resource before the period ends.]",
      },
      reversal: {
        title: "4. Cancelled charges and partial refunds",
        p1: "When we cancel a purchase or a renewal, we cancel all of it: the whole amount goes back to your wallet and you get a credit note in taka for its invoice. [To be decided: whether a charge by use gets a credit note when it is cancelled.]",
        p2: "A refund of part of a charge is only made by hand, after two members of our staff have approved it, and the reason is recorded. [To be decided: when a partial refund is given.]",
      },
      payout: {
        title: "5. Paying out wallet money",
        p1: "EPS has no automatic refund at present. When money from your wallet is paid back to you, our finance staff pay it through EPS by hand and record it in your wallet.",
        p2: "[To be decided: when wallet money can be paid back, to which account, any minimum amount, and how long it takes.]",
      },
      review: {
        title: "6. Payments under review",
        p1: "If EPS reports a payment as successful but the amount does not match, we do not add it to your wallet. Our finance staff check it, and the panel shows the payment as pending with a note to contact support.",
      },
      ask: {
        title: "7. How to ask",
        p1: "For a question about a charge or a refund, open a support request about billing in the panel.",
      },
    },
  },
};
