// Namespace `Cdn` of the customer app (WP7-T2). Bengali is written first (rule U5); `cdn-en.ts` is
// typed from this tree, so a missing key fails `tsc`. AWS is named by the rules of 16.13: "CDN" with
// "Amazon Lightsail CDN distribution" beside it on the first mention of a page. No account id, no
// ARN, no raw AWS text (U6). The default domain of a distribution is shown because the customer needs
// it to use the distribution.
export const cdnBn = {
  Cdn: {
    meta: { title: "সিডিএন" },
    heading: "সিডিএন",
    awsNote:
      "প্রতিটি সিডিএন একটি Amazon Lightsail CDN distribution। আপনার কনটেন্টের কপি বিশ্বজুড়ে AWS-এর edge লোকেশনে রাখা হয়।",
    flagOff: {
      title: "সিডিএন শিগগিরই আসছে",
      body: "এই সেবা এখনও আপনার বাজারে খোলা হয়নি। খুললে এখানেই কিনতে পারবেন।",
    },
    kycRequired: {
      title: "আগে পরিচয় যাচাই করুন",
      body: "সিডিএন কিনতে পরিচয় যাচাই সম্পন্ন হতে হয়। যাচাই শেষ হলে এখানে ফিরে আসুন।",
      action: "সাপোর্টে লিখুন",
    },
    state: {
      creating: "তৈরি হচ্ছে",
      active: "চালু",
      stopped: "বন্ধ",
      suspended: "স্থগিত",
      destroyed: "মুছে ফেলা হয়েছে",
      failed: "সমস্যা হয়েছে",
    },
    cache: {
      cache: "ক্যাশ করা হবে",
      "dont-cache": "ক্যাশ করা হবে না",
    },
    origin: {
      server: "ক্লাউড সার্ভার",
      loadBalancer: "লোড ব্যালান্সার",
      bucket: "অবজেক্ট স্টোরেজ",
      none: "পাওয়া যায়নি",
    },
    plan: {
      small: "ছোট",
      medium: "মাঝারি",
      large: "বড়",
      transfer: "{size} GB ডেটা ট্রান্সফার প্রতি মাসে",
    },
    list: {
      caption: "আপনার সিডিএনের তালিকা",
      name: "নাম",
      origin: "উৎস",
      domain: "ডিফল্ট ডোমেইন",
      state: "অবস্থা",
      none: "—",
      create: "নতুন সিডিএন",
      empty: {
        title: "এখনও কোনো সিডিএন নেই",
        body: "আপনার সার্ভার, লোড ব্যালান্সার বা অবজেক্ট স্টোরেজের সামনে একটি সিডিএন বসান।",
      },
    },
    new: {
      meta: { title: "নতুন সিডিএন" },
      heading: "নতুন সিডিএন",
      intro:
        "সিডিএন আপনার কনটেন্টের কপি দর্শকের কাছাকাছি রাখে। উৎস হিসেবে আপনার নিজের সার্ভার, লোড ব্যালান্সার বা অবজেক্ট স্টোরেজ বেছে নিন।",
      step: {
        origin: "১. উৎস",
        plan: "২. প্ল্যান",
        cache: "৩. ক্যাশ আচরণ",
        name: "৪. নাম",
      },
      originHint:
        "শুধু আপনার নিজের চালু সার্ভার, লোড ব্যালান্সার বা অবজেক্ট স্টোরেজ দেখানো হয়। সার্ভারে স্ট্যাটিক আইপি লাগানো থাকতে হবে।",
      planLegend: "প্ল্যান বেছে নিন",
      cacheHint:
        "স্ট্যাটিক সাইটের জন্য “ক্যাশ করা হবে” ভালো। ব্যক্তিভেদে বদলানো কনটেন্টে ক্যাশ বন্ধ রাখুন।",
      nameHint: "শুধু আপনার জন্য। ইংরেজি অক্ষর, সংখ্যা, স্পেস, ডট, আন্ডারস্কোর ও হাইফেন চলবে।",
      namePlaceholder: "যেমন: আমার-সাইট-সিডিএন",
      noPlans: {
        title: "এখন কোনো প্ল্যান বিক্রির জন্য নেই",
        body: "একটু পরে আবার দেখুন।",
      },
      noOrigins: {
        title: "সিডিএনের জন্য কোনো উৎস নেই",
        body: "আগে একটি চালু ক্লাউড সার্ভার, লোড ব্যালান্সার বা অবজেক্ট স্টোরেজ নিন।",
        action: "ক্লাউড সার্ভার দেখুন",
      },
      customDomainNote:
        "নিজের ডোমেইন ও সার্টিফিকেট এখনই যোগ করা যায় না। তৈরির পর পাওয়া ডিফল্ট ডোমেইন ব্যবহার করুন।",
      summary: {
        title: "অর্ডারের সারসংক্ষেপ",
        origin: "উৎস",
        cache: "ক্যাশ",
        term: "মেয়াদ",
        termValue: "৩০ দিন",
        price: "মোট মূল্য",
      },
      submit: "রিভিউতে যান",
    },
    detail: {
      meta: { title: "সিডিএনের বিবরণ" },
      back: "সব সিডিএন",
      tabsLabel: "সিডিএনের বিভাগ",
      notFound: {
        title: "সিডিএন পাওয়া যায়নি",
        body: "এই সিডিএন নেই, অথবা আপনার অ্যাকাউন্টের নয়।",
      },
      header: { aws: "Amazon Lightsail CDN distribution" },
      tab: { overview: "সারসংক্ষেপ", settings: "সেটিংস", destroy: "মুছে ফেলা" },
      overview: {
        origin: "উৎস",
        cache: "ক্যাশ আচরণ",
        location: "লোকেশন",
        locationValue: "বিশ্বজুড়ে edge লোকেশন",
        domain: "ডিফল্ট ডোমেইন",
        domainHint: "আপনার ওয়েবসাইটের লিংকে বা DNS-এ এই ঠিকানা ব্যবহার করুন।",
        domainPending: "ডোমেইন তৈরি হলে এখানে দেখা যাবে।",
        created: "তৈরির তারিখ",
        recreated: "মুছে ফেলার পর ফিরিয়ে আনলে সেটিংস থাকে, কিন্তু ডিফল্ট ডোমেইন বদলে যায়।",
      },
      switch: {
        title: "সিডিএন চালু বা বন্ধ",
        bodyOn:
          "সিডিএন বন্ধ করলে দর্শকেরা আর কপি পাবে না। সেটিংস থাকে, এবং মেয়াদের মূল্য একই থাকে।",
        bodyOff: "সিডিএন এখন বন্ধ। চালু করলে আগের ডোমেইনেই আবার কাজ করবে।",
        turnOff: "বন্ধ করুন",
        turnOn: "চালু করুন",
        unavailable: "এই অবস্থায় সিডিএন চালু বা বন্ধ করা যায় না।",
      },
      destroy: {
        title: "সিডিএন মুছে ফেলুন",
        body: "সিডিএন মুছলে ডিফল্ট ডোমেইন আর কাজ করবে না। এর কোনো স্ন্যাপশট হয় না; সেটিংস রাখা থাকে, ফিরিয়ে আনলে সেই সেটিংসে নতুন সিডিএন তৈরি হয়।",
        button: "সিডিএন মুছুন",
        dialogTitle: "সিডিএন মুছে ফেলবেন?",
        dialogBody: "এটি ফেরানো যায় না। নিশ্চিত করতে সিডিএনের নাম লিখুন।",
      },
    },
    order: { open: "সিডিএন খুলুন" },
    error: {
      unauthenticated: "সেশন শেষ হয়েছে। আবার সাইন ইন করুন।",
      fresh_sign_in_required: "নিরাপত্তার জন্য আবার সাইন ইন করুন, তারপর চেষ্টা করুন।",
      flag_off: "এই সেবা এখন আপনার জন্য খোলা নেই।",
      validation: "দেওয়া তথ্যে ভুল আছে। আবার চেষ্টা করুন।",
      rate_limited: "অল্প সময়ে অনেক অনুরোধ হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      not_found: "এটি পাওয়া যায়নি।",
      name_mismatch: "নাম মেলেনি। হুবহু একই নাম লিখুন।",
      not_allowed: "এই অবস্থায় কাজটি করা যায় না।",
      unavailable: "এখন কাজটি শেষ করা গেল না। একটু পরে আবার চেষ্টা করুন।",
    },
    done: {
      enabled: "সিডিএন চালু করার অনুরোধ নেওয়া হয়েছে।",
      disabled: "সিডিএন বন্ধ করার অনুরোধ নেওয়া হয়েছে।",
      destroyQueued: "মুছে ফেলার অনুরোধ নেওয়া হয়েছে।",
      approval: "স্টাফের অনুমোদনের পর এটি কার্যকর হবে।",
    },
  },
};
