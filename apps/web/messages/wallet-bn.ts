// Namespace `Wallet` of the customer app (WP3-T4). Bengali is written first (rule U5);
// `wallet-en.ts` is typed from this tree, so a missing key fails `tsc`.
export const walletBn = {
  Wallet: {
    meta: { title: "ওয়ালেট" },
    heading: "ওয়ালেট",
    balance: {
      label: "বর্তমান ব্যালেন্স",
      hint: "এই ব্যালেন্স দিয়ে সার্ভার ও অন্য সার্ভিস কেনা যায়।",
    },
    open: {
      label: "অপেক্ষমাণ পেমেন্ট",
      hint: "যাচাই শেষ হলে ব্যালেন্সে যোগ হবে।",
    },
    topUp: "টপ আপ",
    ledger: {
      title: "লেনদেন",
      caption: "ওয়ালেটের লেনদেনের তালিকা",
      date: "তারিখ",
      description: "বিবরণ",
      in: "জমা",
      out: "খরচ",
      balance: "ব্যালেন্স",
      kind: {
        topup: "টপ আপ",
        purchase: "কেনাকাটা",
        renewal: "নবায়ন",
        metered_charge: "ব্যবহারের চার্জ",
        reversal: "স্বয়ংক্রিয় ফেরত",
        adjustment: "সমন্বয়",
        refund: "রিফান্ড",
        other: "অন্যান্য",
      },
      empty: {
        title: "এখনো কোনো লেনদেন নেই",
        body: "টপ আপ করলে এখানে দেখা যাবে।",
      },
    },
    payments: {
      title: "পেমেন্ট",
      caption: "টপ আপ পেমেন্টের তালিকা",
      amount: "পরিমাণ",
      state: "অবস্থা",
      view: "দেখুন",
      empty: "এখনো কোনো পেমেন্ট নেই।",
    },
    state: {
      credited: "জমা হয়েছে",
      pending: "অপেক্ষমাণ",
      failed: "ব্যর্থ",
      cancelled: "বাতিল",
      expired: "মেয়াদ শেষ",
    },
    banner: {
      checking: "আপনার পেমেন্ট যাচাই করা হচ্ছে। যাচাই শেষ হলে ব্যালেন্স বদলাবে।",
      credited: "আপনার টপ আপ সম্পন্ন হয়েছে।",
      failed: "পেমেন্ট সম্পন্ন হয়নি। কোনো টাকা কাটা হয়নি।",
      cancelled: "আপনি পেমেন্ট বাতিল করেছেন।",
      expired: "পেমেন্টের সময় শেষ হয়ে গেছে।",
      unknown: "এই পেমেন্ট আমরা খুঁজে পাইনি।",
    },
    paging: { newer: "নতুন", older: "পুরোনো" },
    error: {
      title: "ওয়ালেট দেখানো যায়নি",
      body: "কিছুক্ষণ পরে আবার চেষ্টা করুন। আপনার ব্যালেন্স অপরিবর্তিত আছে।",
      retry: "আবার চেষ্টা করুন",
    },
  },
};
