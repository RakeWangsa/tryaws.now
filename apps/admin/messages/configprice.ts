// Namespace `AdminConfigPrices`: /pricing/config, the prices that no AWS API fills (WPU-G10): block storage
// and snapshot per GB-month, the load balancer and the hosted zone per month. Dated entries, a live preview
// by the pricing engine, a history with the reason of every change. A namespace of its own, so the other
// admin screens do not touch this file. Bengali first (rule U5); the English tree is typed from it, so a
// missing key fails `tsc`. Money never appears here: amounts are formatted by the kit from paisa.
export const configPriceBn = {
  AdminConfigPrices: {
    title: "AWS-এ দাম নেই এমন পণ্যের মূল্য",
    intro:
      "লোড ব্যালান্সার, স্ন্যাপশট, ব্লক স্টোরেজ ও ডিএনএস জোনের দাম AWS-এর কোনো API থেকে আসে না। এখানে ডলারে মূল দাম দিন, আর কবে থেকে চালু হবে তা ঠিক করুন। নতুন দাম শুধু নতুন অর্ডারে লাগে। হয়ে যাওয়া অর্ডার ও চলতি মেয়াদের মূল্য বদলায় না। মূল্যের নিয়ম ও মার্জিন আলাদা পাতায়।",
    back: "মূল্য ও বিনিময় হারের পাতায় যান",
    market: { label: "বাজার", submit: "দেখুন" },
    unavailable: {
      title: "তথ্য আনা যায়নি",
      body: "এখন তথ্য পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
    },
    result: {
      ok: "সংরক্ষণ হয়েছে।",
      replayed: "এই পরিবর্তন আগেই সংরক্ষিত ছিল।",
      invalid: "ফর্মের তথ্য ঠিক নয়। ঘরগুলো আবার দেখুন।",
      denied: "এই কাজের অনুমতি আপনার নেই।",
      conflict: "একই সময়ের জন্য অন্য দাম আগে থেকেই আছে। অন্য সময় দিন।",
      not_found: "চলমান বিনিময় হার বা মূল্যের নিয়ম পাওয়া যায়নি।",
      rate_limited: "অনেকবার চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      unavailable: "এখন কাজটি করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
    },
    summary: {
      fx: "চলমান ডলার হার",
      noFx: "এই বাজারে কোনো হার নেই, তাই কোনো মূল্য দেখানো যাচ্ছে না।",
      rounding: "রাউন্ডিং",
      roundingValue: "হাফ-আপ (০.৫ ওপরে), পয়সায়",
    },
    names: {
      block_storage_gb_month: "ব্লক স্টোরেজ (প্রতি GB, প্রতি মাস)",
      snapshot_gb_month: "স্ন্যাপশট (প্রতি GB, প্রতি মাস)",
      load_balancer_month: "লোড ব্যালান্সার (প্রতি মাস)",
      dns_zone_month: "ডিএনএস জোন (প্রতি মাস)",
      static_ip_unattached_hour: "আনঅ্যাটাচড স্ট্যাটিক আইপি (প্রতি ঘণ্টা)",
    },
    unit: { gb_month: "GB-মাস", month: "মাস", hour: "ঘণ্টা" },
    list: {
      title: "দামের তালিকা",
      intro:
        "AWS-এর মূল দাম ডলারে। গ্রাহকের দাম হিসাব করে পণ্যের মূল্যের নিয়ম, বিনিময় হার ও মার্জিন দিয়ে; এটি কোথাও জমা থাকে না।",
      caption: "AWS-এ দাম নেই এমন পণ্যের দাম",
    },
    columns: {
      name: "পণ্য",
      unit: "একক",
      usd: "চলমান দাম (USD)",
      customer: "গ্রাহকের দাম (এক এককে)",
      scheduled: "পরের পরিবর্তন",
      used: "অর্ডারে ব্যবহার",
    },
    state: {
      none: "দাম দেওয়া হয়নি",
      invalid: "পড়া যাচ্ছে না",
      readNow: "অর্ডারে লাগে",
      notReadYet: "এখনো অর্ডার পড়ে না",
    },
    editor: {
      title: "দাম বদলান: {name}",
      edit: "বদলান",
      intro:
        "নতুন দাম দিন, তারপর আগে প্রিভিউ দেখুন। প্রিভিউ ঠিক হলে তবেই সংরক্ষণের বোতাম আসবে। শুরুর সময় ফাঁকা রাখলে এখনই চালু হবে।",
      notReadYet:
        "সতর্কতা: এই দাম সংরক্ষিত ও পরিবর্তনযোগ্য, কিন্তু বর্তমানে কোনো অর্ডার এটি পড়ে না। অর্ডারে ব্যবহারের আগে এটি জুড়তে হবে।",
      usd: "AWS-এর দাম (USD, এক এককে)",
      usdHint: "সংখ্যা, সর্বোচ্চ ৪ দশমিক। শূন্য নয়। যেমন ০.৫০ বা ১৮।",
      from: "শুরুর সময় (ঢাকা)",
      fromHint: "বছর-মাস-দিনTঘণ্টা:মিনিট, যেমন 2026-12-01T09:00। সর্বোচ্চ ৯০ দিন পরের।",
      previewSubmit: "প্রিভিউ দেখুন",
    },
    preview: {
      caption: "প্রিভিউ: {name}",
      priceNow: "এখনকার দাম",
      priceNew: "নতুন দাম",
      margin: "মার্জিন",
      commission: "কমিশন",
      change: "পরিবর্তন",
      onlyNew: "নতুন দাম শুধু নতুন অর্ডারে লাগে।",
      invalid: "প্রিভিউ করা যায়নি। দেখুন: {fields}",
      unavailable: "এখন প্রিভিউ করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
      saveTitle: "সংরক্ষণ",
      save: "দাম সংরক্ষণ করুন",
    },
    reason: {
      label: "কারণ",
      hint: "যেমন: AWS মূল্যতালিকা পাতা, তারিখসহ। অডিট লগে যাবে।",
    },
    history: {
      title: "ইতিহাস",
      caption: "{name}-এর দামের ইতিহাস",
      auditCaption: "পরিবর্তনের কারণ",
      empty: "এই দামের কোনো ইতিহাস নেই।",
      from: "শুরু",
      state: "অবস্থা",
      usd: "ডলার (USD)",
      by: "কে",
      when: "কখন",
      reason: "কারণ",
      inForce: "চলমান",
      scheduled: "পরে চালু হবে",
      past: "আগের",
    },
  },
};
