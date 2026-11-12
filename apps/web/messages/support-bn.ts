// Namespace `SupportForm` of the customer app (WP9-T4b): the signed-in support form of 16.10
// (/support when signed in). Bengali is written first (rule U5); `support-en.ts` is typed from this
// tree, so a missing key fails `tsc`. No AWS name, account id or raw error appears in a text (U6).
export const supportBn = {
  SupportForm: {
    meta: { title: "সাপোর্টে অনুরোধ" },
    heading: "সাপোর্টে অনুরোধ",
    intro:
      "সমস্যা বা প্রশ্ন লিখে পাঠান। MeghVPS-এর সাপোর্ট দল আপনার অ্যাকাউন্টের ইমেইলে উত্তর দেবে।",
    form: {
      title: "নতুন অনুরোধ",
      category: {
        legend: "বিষয়ের ধরন",
        billing: "বিল ও ওয়ালেট",
        technical: "কারিগরি সমস্যা",
        kyc: "পরিচয় যাচাই",
        domain: "ডোমেইন ও DNS",
        abuse: "অপব্যবহারের অভিযোগ",
        other: "অন্য কিছু",
      },
      subject: { label: "বিষয়", hint: "এক লাইনে, সর্বোচ্চ ১২০ অক্ষর।" },
      message: { label: "বার্তা", hint: "যা ঘটেছে তা লিখুন। পাসওয়ার্ড বা গোপন কোড লিখবেন না।" },
      submit: "অনুরোধ পাঠান",
      working: "পাঠানো হচ্ছে…",
    },
    done: {
      title: "অনুরোধ পাঠানো হয়েছে",
      body: "আমরা আপনার অনুরোধ পেয়েছি। উত্তর অ্যাকাউন্টের ইমেইলে আসবে।",
      reference: "অনুরোধের রেফারেন্স",
      again: "আরেকটি অনুরোধ লিখুন",
      replayed: "এই অনুরোধ আগেই পাঠানো হয়েছিল, নতুন করে যোগ করা হয়নি।",
    },
    list: {
      title: "আপনার আগের অনুরোধ",
      caption: "আপনার সাপোর্ট অনুরোধের তালিকা",
      subject: "বিষয়",
      category: "ধরন",
      status: "অবস্থা",
      sentOn: "পাঠানোর তারিখ",
      empty: { title: "এখনও কোনো অনুরোধ নেই", body: "অনুরোধ পাঠালে এখানে দেখা যাবে।" },
    },
    status: { open: "খোলা", closed: "বন্ধ" },
    error: {
      unauthenticated: "আপনার সেশন শেষ হয়েছে। আবার সাইন ইন করুন।",
      validation: "কিছু তথ্য ঠিক নয়। চিহ্নিত ঘর ঠিক করে আবার চেষ্টা করুন।",
      rate_limited: "অল্প সময়ে অনেক অনুরোধ হয়েছে। একটু অপেক্ষা করে আবার চেষ্টা করুন।",
      forbidden: "এই কাজটি করা গেল না।",
      unavailable: "এখন শেষ করা গেল না। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
    },
    field: { invalid: "এই ঘরের তথ্য ঠিক নয়।" },
  },
};
