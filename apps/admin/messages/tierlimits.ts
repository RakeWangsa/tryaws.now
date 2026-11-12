// Namespace `AdminTierLimits`: /catalog/limits, the limits of each risk tier in a market (WPU-G10): how many
// resources a customer of the tier may hold, the dearest bundle, and whether Windows and containers are
// open. A saved setting replaces the defaults of the core. A namespace of its own. Bengali first (rule U5);
// the English tree is typed from it, so a missing key fails `tsc`.
export const tierLimitsBn = {
  AdminTierLimits: {
    title: "ঝুঁকির স্তরের সীমা",
    intro:
      "প্রতিটি স্তরের গ্রাহক কতগুলো রিসোর্স রাখতে পারবেন, সবচেয়ে দামি বান্ডল কত, আর উইন্ডোজ ও কনটেইনার খোলা কি না, এখানে ঠিক করুন। সংরক্ষিত মান কোডের ডিফল্টের জায়গা নেয়। সীমা কমালে গ্রাহকের চালু রিসোর্স বদলায় না; শুধু সীমার বেশি নতুন অর্ডার বন্ধ হয়। সংরক্ষিত মান পড়া না গেলে সেই স্তরের অর্ডার বন্ধ থাকে।",
    back: "ক্যাটালগ ও ফ্ল্যাগের পাতায় যান",
    market: { label: "বাজার", submit: "দেখুন" },
    unavailable: {
      title: "তথ্য আনা যায়নি",
      body: "এখন তথ্য পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
    },
    result: {
      ok: "সংরক্ষণ হয়েছে।",
      replayed: "এই পরিবর্তন আগেই সংরক্ষিত ছিল।",
      invalid: "ফর্মের তথ্য ঠিক নয়। ঘরগুলো আবার দেখুন এবং কারণ লিখুন।",
      denied: "এই কাজের অনুমতি আপনার নেই।",
      conflict: "একই সময়ে অন্য একটি পরিবর্তন হয়েছে। আবার চেষ্টা করুন।",
      not_found: "পাওয়া যায়নি।",
      rate_limited: "অনেকবার চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      unavailable: "এখন কাজটি করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
    },
    tiers: { new: "নতুন গ্রাহক", trusted: "বিশ্বস্ত গ্রাহক" },
    source: {
      stored: "সংরক্ষিত মান",
      default: "ডিফল্ট মান",
      invalid: "পড়া যাচ্ছে না",
    },
    invalid:
      "সংরক্ষিত মানটি পড়া যাচ্ছে না, তাই এই স্তরের গ্রাহকের অর্ডার বন্ধ আছে। নিচের ফর্মে নতুন মান সংরক্ষণ করলে ঠিক হবে।",
    values: { yes: "হ্যাঁ", no: "না" },
    editor: {
      maxInstances: "রিসোর্সের সর্বোচ্চ সংখ্যা",
      maxInstancesHint:
        "প্রতিটি পণ্যের জন্য আলাদা গোনা হয়। সার্ভার (লিনাক্স ও উইন্ডোজ) একসাথে গোনা হয়। ১ থেকে ১০০০০০।",
      maxBundleUsd: "সবচেয়ে দামি বান্ডলের মাসিক দাম (USD)",
      maxBundleUsdHint: "AWS-এর দাম ডলারে, যেমন ২৪। শূন্য নয়।",
      maxStaticIps: "স্ট্যাটিক আইপির সর্বোচ্চ সংখ্যা",
      maxStaticIpsHint: "০ থেকে ১০০০০০।",
      windows: "উইন্ডোজ সার্ভার খোলা",
      containers: "কনটেইনার সার্ভিস খোলা",
      reason: "কারণ",
      reasonHint: "অডিট লগে যাবে।",
      save: "সীমা সংরক্ষণ করুন",
    },
    history: {
      title: "ইতিহাস",
      caption: "{tier} স্তরের পরিবর্তন",
      empty: "এই স্তরের সীমা কখনো বদলানো হয়নি।",
      when: "কখন",
      by: "কে",
      change: "রিসোর্স সংখ্যা",
      reason: "কারণ",
    },
  },
};
