// Namespace `DiskRestore` (WPU-X2): the form that makes a new disk from a snapshot of a disk. Bengali
// first (U5); `disk-restore-en.ts` is typed from this tree. AWS is named openly (16.13); no account id,
// ARN or raw AWS text (U6).
export const diskRestoreBn = {
  DiskRestore: {
    meta: { title: "স্ন্যাপশট থেকে নতুন ডিস্ক" },
    heading: "স্ন্যাপশট থেকে নতুন ডিস্ক",
    intro:
      "আপনার একটি ডিস্কের স্ন্যাপশট থেকে নতুন ডিস্ক তৈরি করুন। নতুন ডিস্ক Amazon Lightsail block storage disk। এটি স্ন্যাপশটের লোকেশনেই হয়, আর কোনো সার্ভারের সাথে যুক্ত থাকে না; পরে ডিস্কটি সার্ভারে যুক্ত করুন।",
    flagOff: {
      title: "ব্লক স্টোরেজ ডিস্ক শিগগিরই আসছে",
      body: "এই সেবা আপনার বাজারে এখনও খোলেনি। খুললে এখানে থেকেই নিতে পারবেন।",
    },
    empty: {
      title: "ডিস্ক বানানোর মতো কোনো স্ন্যাপশট নেই",
      body: "একটি সক্রিয় স্ন্যাপশট থাকলে এবং ডিস্কের জন্য মূল্য নির্ধারিত থাকলে এখানে দেখা যাবে।",
    },
    snapshot: "স্ন্যাপশট",
    snapshotOption: "{name} · {location} · কমপক্ষে {size} GB",
    unnamed: "নামহীন স্ন্যাপশট",
    sourceDestroyed: "মুছে ফেলা ডিস্কের শেষ স্ন্যাপশট",
    name: "নতুন ডিস্কের নাম",
    hint: "অক্ষর, সংখ্যা, স্পেস, ডট, হাইফেন ও আন্ডারস্কোর, সর্বোচ্চ ৬০ অক্ষর।",
    size: "আকার (GB)",
    sizeHint: "{min} থেকে {max} GB এর মধ্যে একটি পূর্ণসংখ্যা। মূল ডিস্কের চেয়ে ছোট হবে না।",
    sizeInvalid: "আকার {min} থেকে {max} GB এর মধ্যে পূর্ণসংখ্যা হতে হবে।",
    price: "প্রতি GB, প্রতি মাস",
    priceNote:
      "মোট মূল্য পরের ধাপে আকার অনুযায়ী দেখানো হবে। আপনি নিশ্চিত না করা পর্যন্ত কোনো টাকা কাটা হবে না।",
    snapshotInvalid: "এই স্ন্যাপশট থেকে এখন ডিস্ক বানানো যাবে না।",
    regionInvalid: "স্ন্যাপশটের লোকেশন মেলেনি।",
    productInvalid: "এই লোকেশনে নতুন ডিস্ক এখন বিক্রি হচ্ছে না।",
    tooSmall: "নতুন ডিস্ক মূল ডিস্কের চেয়ে ছোট হতে পারে না।",
    submit: "পরের ধাপে যান",
    link: "স্ন্যাপশট থেকে নতুন ডিস্ক বানান",
    error: {
      limit_reached: "আপনার সীমা পূর্ণ হয়েছে।",
      capacity_full: "এই লোকেশনে এখন জায়গা নেই। একটু পরে আবার চেষ্টা করুন।",
      kyc_required: "আগে পরিচয় যাচাই সম্পন্ন করুন।",
      forbidden: "এটি আপনার জন্য খোলা নেই।",
    },
  },
} as const;
