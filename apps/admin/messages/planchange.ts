// Namespace `AdminPlanChange`: /operations/resources/[id], the plan change of a container service or a CDN
// (WPA-P2): the plan the resource has, the plan scheduled for the next renewal, the failure mark of an
// apply, the apply operation on its way, and the audited action that clears the mark. A namespace of its
// own. Bengali first (rule U5); the English tree is typed from it, so a missing key fails `tsc`. No AWS
// account id, ARN or raw error text is written here or shown: the stored code is mapped to the fixed
// lines of `AdminOps.errors` (R14).
export const planChangeBn = {
  AdminPlanChange: {
    title: "প্ল্যান বদলের অবস্থা",
    back: "অপারেশনের তালিকায় ফিরুন",
    intro:
      "কনটেইনার সার্ভিস ও সিডিএনের প্ল্যান বদল পরের নবায়নে কার্যকর হয়। এখানে দেখা যায় রিসোর্সের এখনকার প্ল্যান, পরের নবায়নে যে প্ল্যান বসবে, আর প্ল্যান বসানোর কাজ ব্যর্থ হয়েছে কি না।",
    unavailable: {
      title: "তথ্য আনা যায়নি",
      body: "এখন তথ্য পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
    },
    result: {
      ok: "চিহ্ন মোছার কাজ সারিতে গেছে।",
      replayed: "এই অনুরোধ আগেই সম্পন্ন হয়েছিল। কিছু বদলায়নি।",
      invalid: "ফর্মের তথ্য ঠিক নয়। কারণ লিখে আবার চেষ্টা করুন।",
      denied: "এই কাজের অনুমতি আপনার নেই।",
      not_found: "যা খুঁজছেন তা পাওয়া যায়নি।",
      conflict: "এই অবস্থায় কাজটি করা যায় না। পাতা নতুন করে খুলে দেখুন।",
      rate_limited: "অনেক বেশি অনুরোধ হয়েছে। একটু পরে আবার চেষ্টা করুন।",
      unavailable: "এখন কাজটি করা যাচ্ছে না। কিছুই বদলায়নি।",
    },
    facts: {
      title: "রিসোর্স",
      resource: "রিসোর্স",
      family: "পণ্য",
      state: "অবস্থা",
      region: "অঞ্চল",
    },
    families: { container_service: "কনটেইনার সার্ভিস", cdn: "সিডিএন" },
    states: {
      creating: "তৈরি হচ্ছে",
      active: "চালু",
      stopped: "বন্ধ",
      suspended: "স্থগিত",
      destroyed: "মুছে ফেলা হয়েছে",
      failed: "ব্যর্থ",
    },
    plans: {
      title: "প্ল্যান",
      applied: "এখন যে প্ল্যান আছে",
      appliedNone: "প্ল্যান বদল এখনও হয়নি। রিসোর্স কেনার সময়ের প্ল্যানই আছে।",
      pending: "পরের নবায়নে যে প্ল্যান বসবে",
      pendingNone: "কোনো প্ল্যান বদল নির্ধারিত নেই।",
      unreadable: "প্ল্যানটি ক্যাটালগে পাওয়া যায়নি",
      offSale: "বিক্রি বন্ধ",
      renewalNote:
        "নবায়নে সবসময় এখনকার প্ল্যান আর নির্ধারিত প্ল্যানের মধ্যে যেটির দাম বেশি, সেটির দাম নেওয়া হয়। কম দামের প্ল্যান এক মেয়াদ পরে শুরু হয়।",
    },
    inFlight: {
      title: "প্ল্যান বসানোর কাজ চলছে",
      body: "প্ল্যান বসানোর একটি কাজ এখন সারিতে বা চলছে। শেষ হওয়ার আগে চিহ্ন মুছলেও ফল বদলাবে না।",
    },
    failed: {
      title: "প্ল্যান বসানো ব্যর্থ হয়েছে",
      body: "পরের নবায়নে নির্ধারিত প্ল্যান বসানোর কাজ শেষ হয়নি। গ্রাহক একই প্ল্যান আবার নির্ধারণ করতে পারছেন না।",
      code: "ব্যর্থতার কারণ",
      product: "যে প্ল্যান বসেনি",
      period: "যে মেয়াদে চার্জ হয়েছিল",
      productUnknown: "জানা নেই (পুরোনো চিহ্ন)",
      periodUnknown: "জানা নেই",
    },
    noMark: {
      title: "ব্যর্থতার চিহ্ন নেই",
      body: "এই রিসোর্সে প্ল্যান বসানোর কোনো ব্যর্থতার চিহ্ন নেই। মোছার কিছু নেই।",
    },
    clear: {
      title: "ব্যর্থতার চিহ্ন মুছুন",
      intro:
        "চিহ্ন মুছলে গ্রাহক ওই প্ল্যান আবার নির্ধারণ করতে পারবেন। মোছার কাজ সারিতে যায় এবং রিসোর্সের সেটিংয়ে বসে।",
      effect:
        "এতে কোনো টাকা ফেরত বা চার্জ হয় না, লেজারে কিছু লেখা হয় না, AWS-এ কিছু বদলায় না। নবায়নের দাম আগের নিয়মেই চলে।",
      reasonLabel: "কারণ",
      reasonHint: "এই কারণ, আপনার নাম ও আইপি অডিটে থাকবে। গ্রাহক এটি দেখবেন না।",
      submit: "চিহ্ন মুছুন",
      pendingClear: "চিহ্ন মোছার একটি কাজ ইতিমধ্যে সারিতে আছে।",
    },
    operations: {
      title: "প্ল্যান বসানোর কাজ",
      caption: "এই রিসোর্সের প্ল্যান বসানো ও চিহ্ন মোছার কাজ, নতুন আগে",
      empty: "এখনও কোনো কাজ নেই।",
      kind: "ধরন",
      state: "অবস্থা",
      error: "শেষ ত্রুটি",
      created: "তৈরি",
      open: "খুলুন",
      view: "দেখুন",
    },
    link: "প্ল্যান বদলের অবস্থা দেখুন",
  },
};
