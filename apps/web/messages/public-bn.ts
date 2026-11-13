import { legalDocsBn } from "./legal-bn.ts";

// Namespace `Public` of the public site (WPP-T1 to WPP-T4). Bengali is written first (rule U5);
// `public-en.ts` is typed from this tree, so a missing key fails `tsc`. The AWS statements themselves
// live in the shell messages (`Aws`, 16.13) and are not repeated here. The legal documents are DRAFTS
// in `legal-bn.ts` (WPU-Z7) that wait for the owner's approval of their exact text.
export const publicBn = {
  Public: {
    crumb: { home: "হোম" },
    meta: {
      home: {
        title: "MeghVPS: ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি",
        description:
          "বাংলাদেশের জন্য প্রিপেইড ক্লাউড প্যানেল। ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি। মূল্য মার্কিন ডলারে, ওয়ালেট টাকায়, EPS দিয়ে টপ আপ।",
      },
      pricing: {
        title: "মূল্য তালিকা: ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি",
        description:
          "ক্লাউড সার্ভারের সব প্ল্যানের মূল্য মার্কিন ডলারে, ৩০ দিনের জন্য। মূল্যে VAT ও ফি অন্তর্ভুক্ত। Amazon Lightsail দিয়ে তৈরি।",
      },
      cloudServers: {
        title: "ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি",
        description:
          "Singapore বা Mumbai AWS Region-এ চলা ক্লাউড সার্ভার। প্ল্যান, স্পেসিফিকেশন ও মূল্য মার্কিন ডলারে। Amazon Lightsail দিয়ে তৈরি।",
      },
      help: {
        title: "সাহায্য ও সাধারণ প্রশ্ন",
        description:
          "MeghVPS ও Amazon Lightsail নিয়ে সাধারণ প্রশ্নের উত্তর: AWS, বিল, সাপোর্ট, ডেটা কোথায় থাকে।",
      },
      support: {
        title: "সাপোর্ট ও যোগাযোগ",
        description:
          "MeghVPS-এর সাপোর্ট পাওয়ার উপায়: প্যানেলে সাপোর্ট অনুরোধ, আর অ্যাকাউন্ট না থাকলে সাপোর্ট পাতার ফর্ম।",
      },
      legal: {
        title: "আইনি নথি",
        description: "MeghVPS-এর শর্তাবলি, গোপনীয়তা, গ্রহণযোগ্য ব্যবহার ও ফেরতের নীতি।",
      },
      soon: {
        description: "এই পণ্য এখনো খোলা হয়নি। খোলা হলে ইমেইলে জানাতে আপনার ঠিকানা দিন।",
      },
      maintenance: { title: "রক্ষণাবেক্ষণ চলছে" },
    },
    common: {
      orderNow: "অর্ডার করুন",
      seePricing: "মূল্য দেখুন",
      seePlans: "প্ল্যান দেখুন",
      login: "প্যানেলে যান",
      // WPU-Y4 wording (approved by the owner on 2026-11-13): USD, taka at checkout, Amazon Lightsail.
      priceNote:
        "মূল্য মার্কিন ডলারে (USD), ৩০ দিনের জন্য, VAT ও ফি অন্তর্ভুক্ত। টাকার পরিমাণ চেকআউটে সেদিনের বিনিময় হারে হিসাব করা হয় এবং নিশ্চিত করার আগেই দেখানো হয়। ১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।",
      unavailableTitle: "মূল্য এখন দেখানো যাচ্ছে না",
      unavailableText: "মূল্য তালিকা এই মুহূর্তে পড়া যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      noPlansTitle: "এখনো কোনো প্ল্যান খোলা নেই",
      noPlansText: "ক্লাউড সার্ভার খোলা হলে এখানে প্ল্যান দেখা যাবে।",
      locationHeading: "লোকেশন",
      comingSoon: "শিগগির আসছে",
    },
    location: {
      "ap-southeast-1": "Singapore",
      "ap-south-1": "Mumbai",
    },
    product: {
      linux_instance: "ক্লাউড সার্ভার",
      windows_instance: "ক্লাউড সার্ভার (Windows)",
      database: "ম্যানেজড ডেটাবেস",
    },
    spec: {
      cpu: "vCPU",
      ram: "মেমরি",
      disk: "ডিস্ক",
      transfer: "ডেটা ট্রান্সফার",
      cpuValue: "{count} vCPU",
      gb: "{count} GB",
      planOf: "{product} {ram} GB",
      nameAt: "{name} · {location}",
      none: "–",
      perLocation: "{location}: {value}",
    },
    home: {
      heroTitle: "ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি",
      heroLead:
        "বাংলাদেশের জন্য প্রিপেইড ক্লাউড প্যানেল। মূল্য মার্কিন ডলারে, ওয়ালেট টাকায়, EPS দিয়ে ওয়ালেটে টপ আপ। সবকিছু এক প্যানেল থেকে চালান।",
      plansTitle: "জনপ্রিয় ক্লাউড সার্ভার প্ল্যান",
      plansLead:
        "বর্তমানে খোলা সবচেয়ে কম মূল্যের প্ল্যান। সব মূল্য সরাসরি মূল্য তালিকা থেকে নেওয়া।",
      whyTitle: "কেন MeghVPS",
      why: {
        aws: {
          title: "১০০% AWS অবকাঠামো",
          text: "প্রতিটি সার্ভার একটি Amazon Lightsail resource, যা আপনার বেছে নেওয়া AWS Region-এ চলে।",
        },
        bdt: {
          title: "ওয়ালেট টাকায়, আগে টপ আপ",
          text: "ওয়ালেটে EPS দিয়ে টাকা যোগ করুন, তারপর সেখান থেকে কিনুন।",
        },
        panel: {
          title: "এক প্যানেল, আলাদা AWS account নয়",
          text: "সার্ভার তৈরি, চালু-বন্ধ ও ব্যাকআপ MeghVPS প্যানেল থেকেই। AWS console-এর দরকার নেই।",
        },
        support: {
          title: "বিল ও সাপোর্ট MeghVPS-এর",
          text: "বিক্রি, বিল ও সাপোর্ট MeghVPS দেয়। সাহায্য দরকার হলে সাপোর্ট অনুরোধ খুলুন।",
        },
      },
      locationsTitle: "দুটি লোকেশন",
      locationsText:
        "শুরুতে দুটি AWS Region: Singapore (ap-southeast-1) ও Mumbai (ap-south-1)। প্ল্যানের ডেটা ট্রান্সফার লোকেশন অনুযায়ী আলাদা হতে পারে।",
      helpTitle: "সাহায্য দরকার?",
      help: {
        faq: { title: "সাধারণ প্রশ্ন", text: "AWS, বিল ও ডেটা নিয়ে উত্তর" },
        support: { title: "সাপোর্ট", text: "আমাদের সঙ্গে যোগাযোগ করুন" },
        pricing: { title: "মূল্য তালিকা", text: "সব প্ল্যান ও মূল্য একসঙ্গে" },
      },
    },
    pricing: {
      heading: "মূল্য তালিকা",
      lead: "ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি। প্রতিটি মূল্য ৩০ দিনের জন্য, মার্কিন ডলারে।",
      tabsLabel: "পণ্যের ধরন",
      tabCloudServers: "ক্লাউড সার্ভার",
      tableTitle: "প্ল্যানের তুলনা",
      colPlan: "প্ল্যান",
      colMemory: "মেমরি",
      colDisk: "ডিস্ক",
      colTransfer: "ডেটা ট্রান্সফার",
      colMonthly: "৩০ দিন",
      colOrder: "অর্ডার",
      tableCaption: "ক্লাউড সার্ভারের প্ল্যান ও লোকেশন অনুযায়ী মূল্য",
      otherFamilies: "অন্যান্য পণ্য",
      otherFamiliesText: "এই পণ্যগুলো ধাপে ধাপে খোলা হচ্ছে। খোলা হলে মূল্য এখানে দেখা যাবে।",
    },
    cloudServers: {
      heading: "ক্লাউড সার্ভার, Amazon Lightsail দিয়ে তৈরি",
      lead: "প্রতিটি ক্লাউড সার্ভার একটি Amazon Lightsail instance, যা Singapore বা Mumbai AWS Region-এ চলে।",
      plansTitle: "প্ল্যান",
      featuresTitle: "যা পাবেন",
      features: {
        panel: {
          title: "সহজ প্যানেল",
          text: "সার্ভার তৈরি, রিবুট, ফায়ারওয়াল ও SSH কী এক জায়গা থেকে।",
        },
        backup: { title: "ব্যাকআপ", text: "ব্যাকআপ নিন ও পুনরুদ্ধার করুন, প্যানেল থেকেই।" },
        bdt: { title: "টাকায় প্রিপেইড", text: "ওয়ালেটে টপ আপ করে সার্ভার কিনুন।" },
        locations: {
          title: "দুটি লোকেশন",
          text: "Singapore বা Mumbai, যেটি আপনার ব্যবহারকারীর কাছে।",
        },
      },
      pickerTitle: "আপনার প্ল্যান বেছে নিন",
      pickerLegend: "প্ল্যান",
      specsTitle: "স্পেসিফিকেশন",
      colLocation: "লোকেশন",
      faqTitle: "এই পণ্য নিয়ে প্রশ্ন",
    },
    soon: {
      title: "{name} শিগগির আসছে",
      text: "এই পণ্য এখনো খোলা হয়নি। খোলা হলে আপনাকে ইমেইলে জানানো হবে।",
      formLabel: "{name} খোলা হলে জানান",
      email: "ইমেইল",
      emailPlaceholder: "name@example.com",
      submit: "আমাকে জানান",
      sending: "পাঠানো হচ্ছে",
      doneTitle: "ধন্যবাদ",
      done: "পণ্য খোলা হলে আমরা আপনাকে ইমেইলে জানাব।",
      back: "মূল্য তালিকায় ফিরুন",
      error: {
        invalid: "সঠিক ইমেইল ঠিকানা দিন।",
        rate_limited: "অনেকবার চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
        unavailable: "এখন সংরক্ষণ করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      },
    },
    family: {
      databases: "ম্যানেজড ডেটাবেস",
      objectStorage: "অবজেক্ট স্টোরেজ",
      loadBalancers: "লোড ব্যালান্সার",
      containers: "কন্টেইনার সার্ভিস",
      cdn: "সিডিএন",
      dns: "ডিএনএস",
      domains: "ডোমেইন",
    },
    familyOpen: {
      text: "এই পণ্য খোলা হয়েছে। প্ল্যান ও মূল্য দেখতে ও কিনতে প্যানেলে যান।",
    },
    help: {
      heading: "সাধারণ প্রশ্ন",
      lead: "MeghVPS ও Amazon Lightsail নিয়ে সবচেয়ে বেশি জিজ্ঞাসিত প্রশ্ন।",
      listTitle: "প্রশ্নোত্তর",
      stillTitle: "উত্তর পাননি?",
      stillText: "সাপোর্ট পাতায় আমাদের জানান।",
      items: {
        realAws: {
          q: "এটি কি সত্যিই AWS?",
          a: "হ্যাঁ, ১০০%। এখানে কেনা প্রতিটি সার্ভার, ডেটাবেস, ডিস্ক ও বাকেট একটি Amazon Lightsail resource, যা আপনার বেছে নেওয়া AWS Region-এ চলে।",
        },
        noAccount: {
          q: "আমি কি AWS account বা AWS console পাব?",
          a: "না। আপনি MeghVPS প্যানেল থেকেই সবকিছু চালান। আলাদা AWS account বা AWS console লাগে না।",
        },
        billing: {
          q: "বিল ও সাপোর্ট কে দেয়?",
          a: "MeghVPS। আমরা বিক্রি করি ও বিল করি, আর প্যানেলের সাপোর্ট অনুরোধের মাধ্যমে সাপোর্ট দিই। সাপোর্টের কোনো ফোন লাইন নেই।",
        },
        dataLocation: {
          q: "আমার ডেটা কোথায় থাকে?",
          a: "সার্ভার, ডেটাবেস, ডিস্ক ও বাকেট আপনার বেছে নেওয়া AWS Region-এ থাকে। CDN-এর কপি বিশ্বজুড়ে AWS-এর edge লোকেশনে থাকে। DNS বৈশ্বিক সেবা। আপনার অ্যাকাউন্ট ও পরিচয়পত্রের নথি AWS Singapore-এ রাখা হয়।",
        },
        payment: {
          q: "কীভাবে টাকা দেব?",
          a: "প্রথমে EPS দিয়ে ওয়ালেটে টপ আপ করুন। তারপর ওয়ালেট থেকে সার্ভার কিনুন। ওয়ালেট ও সব পেমেন্ট টাকায়; অর্ডারের টাকার পরিমাণ চেকআউটে দেখানো হয়।",
        },
        priceIncludes: {
          q: "মূল্যে কী কী অন্তর্ভুক্ত?",
          a: "প্রদর্শিত মূল্য মার্কিন ডলারে, ৩০ দিনের জন্য এবং তাতে VAT ও ফি অন্তর্ভুক্ত। চেকআউটে সেদিনের বিনিময় হার ও টাকার পরিমাণ নিশ্চিত করার আগেই দেখানো হয়, এবং ঠিক সেই পরিমাণই কাটা হয়।",
        },
        locations: {
          q: "কোন কোন লোকেশন আছে?",
          a: "শুরুতে দুটি AWS Region: Singapore ও Mumbai। প্ল্যানের ডেটা ট্রান্সফার লোকেশন অনুযায়ী আলাদা হতে পারে, তাই মূল্য তালিকায় প্রতিটি লোকেশনের মান আলাদা দেখানো হয়।",
        },
        identity: {
          q: "সার্ভার কেনার আগে পরিচয় যাচাই লাগে?",
          a: "হ্যাঁ। সার্ভার কেনার আগে একবার পরিচয় যাচাই সম্পন্ন করতে হয়। কর্মী যাচাই করে ফল জানান।",
        },
        products: {
          q: "ডেটাবেস, স্টোরেজ ও অন্য পণ্য কবে?",
          a: "পণ্যগুলো ধাপে ধাপে খোলা হচ্ছে। যেটি এখনো খোলেনি, তার পাতায় আপনার ইমেইল দিলে খোলা হলে জানানো হবে।",
        },
        port25: {
          q: "ইমেইল পাঠানোর জন্য পোর্ট ২৫ খোলা থাকে?",
          a: "না। বাইরে যাওয়া পোর্ট ২৫ বন্ধ থাকে। ইমেইল পাঠাতে একটি ইমেইল সেবার API বা অন্য পোর্ট ব্যবহার করুন।",
        },
        support: {
          q: "সাহায্য কোথায় পাব?",
          a: "প্যানেলে সাপোর্ট অনুরোধ খুলুন এবং সেখানেই আমাদের উত্তর দেখুন। অ্যাকাউন্ট না থাকলে সাপোর্ট পাতার ফর্ম ব্যবহার করুন, আমরা ইমেইলে উত্তর দেব। সাপোর্টের কোনো ফোন লাইন বা ইমেইল ঠিকানা নেই।",
        },
        bdt: {
          q: "মূল্য কি টাকায়?",
          a: "মূল্য মার্কিন ডলারে দেখানো হয়। ওয়ালেট, টপ আপ ও ইনভয়েস বাংলাদেশি টাকায় (BDT); অর্ডারের টাকার পরিমাণ চেকআউটে সেদিনের বিনিময় হারে হিসাব করা হয়।",
        },
      },
    },
    support: {
      heading: "সাপোর্ট ও যোগাযোগ",
      lead: "MeghVPS সাপোর্ট দেয় সাপোর্ট অনুরোধের মাধ্যমে, এবং প্রতিটি অনুরোধের লিখিত উত্তর দেয় আমাদের সাপোর্ট দল। সাপোর্টের কোনো ফোন লাইন বা ইমেইল ঠিকানা নেই।",
      customerTitle: "আপনার অ্যাকাউন্ট থাকলে",
      customerText:
        "প্যানেলে সাপোর্ট অনুরোধ খুলুন এবং সেখানেই সেটি অনুসরণ করুন: আমাদের উত্তর পড়ুন এবং একই জায়গায় জবাব দিন। সাইন ইন করা না থাকলে আগে সাইন ইন করতে হবে।",
      newCta: "সাপোর্ট অনুরোধ খুলুন",
      requestsCta: "আমার সাপোর্ট অনুরোধ",
      visitorTitle: "অ্যাকাউন্ট না থাকলে",
      visitorText: "নিচের ফর্মে আমাদের লিখুন। আপনার দেওয়া ইমেইল ঠিকানায় আমরা উত্তর পাঠাব।",
      faqTitle: "আগে সাধারণ প্রশ্ন দেখুন",
      faqText: "বেশিরভাগ প্রশ্নের উত্তর সেখানে আছে।",
      faqCta: "সাধারণ প্রশ্ন",
      form: {
        title: "আমাদের লিখুন",
        lead: "অ্যাকাউন্ট লাগে না। আমরা ইমেইলে উত্তর দিই। এখানে পাসওয়ার্ড, কার্ডের নম্বর বা পরিচয়পত্রের নম্বর লিখবেন না।",
        email: "আপনার ইমেইল",
        emailPlaceholder: "name@example.com",
        name: "আপনার নাম (ঐচ্ছিক)",
        category: "বিষয়",
        subject: "শিরোনাম",
        message: "আপনার বার্তা",
        honeypot: "এই ঘরটি খালি রাখুন",
        submit: "পাঠান",
        doneTitle: "ধন্যবাদ",
        done: "আপনার বার্তা পেয়েছি, ইমেইলে উত্তর দেব।",
        categories: {
          billing: "বিল ও পেমেন্ট",
          technical: "কারিগরি সাহায্য",
          kyc: "পরিচয় যাচাই",
          domain: "ডোমেইন",
          abuse: "অপব্যবহারের অভিযোগ",
          other: "অন্য কিছু",
        },
        error: {
          invalid: "চিহ্নিত ঘরগুলো দেখে আবার চেষ্টা করুন।",
          rate_limited: "অনেকবার চেষ্টা হয়েছে। একটু পরে আবার চেষ্টা করুন।",
          unavailable: "এখন সংরক্ষণ করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
        },
        fieldInvalid: "এই ঘরটি দেখুন।",
        reference: "আবার লিখলে এই কোডটি জানাবেন: {ref}",
      },
    },
    legal: {
      heading: "আইনি নথি",
      sidebarTitle: "নথি",
      sidebarLabel: "আইনি নথির তালিকা",
      // WPU-Z7: shown until the owner approves the exact texts (manual proof wp9-t5-legal-final).
      draftTitle: "খসড়া — চূড়ান্ত অনুমোদনের অপেক্ষায়",
      draftText:
        "এই লেখা একটি খসড়া। চূড়ান্ত অনুমোদনের পরই এটি কার্যকর হবে, তার আগে এতে পরিবর্তন হতে পারে। তৃতীয় বন্ধনীর ভেতরের বিষয়গুলোর সিদ্ধান্ত এখনো বাকি।",
      version: "সংস্করণ: খসড়া ১, ১৩ নভেম্বর ২০২৬",
      docs: legalDocsBn,
    },
    system: {
      maintenanceTitle: "রক্ষণাবেক্ষণ চলছে",
      maintenanceText: "আমরা সেবা উন্নত করছি। শিগগির ফিরে আসব।",
      errorTitle: "কিছু একটা ভুল হয়েছে",
      errorText: "পাতাটি দেখানো যায়নি। আবার চেষ্টা করুন।",
      retry: "আবার চেষ্টা করুন",
      home: "হোমে যান",
      contactUs: "যোগাযোগ করুন",
    },
  },
};
