// The messages of /invoices and /invoices/[id] (WPU-G4), Bengali. The English file takes its shape from
// this one. The number of an invoice is a technical value and keeps Latin digits (16.13).
export const invoicesBn = {
  Invoices: {
    meta: { title: "ইনভয়েস" },
    heading: "ইনভয়েস",
    intro: "প্রতিটি কেনা বা নবায়নের ইনভয়েস এখানে থাকে। বিক্রি, বিল ও সাপোর্ট TiCON Cloud দেয়।",
    list: {
      caption: "আপনার ইনভয়েস",
      number: "নম্বর",
      date: "তারিখ",
      total: "মোট",
      view: "দেখুন",
      older: "আগের ইনভয়েস",
    },
    empty: {
      title: "এখনও কোনো ইনভয়েস নেই",
      body: "প্রথম সার্ভার বা সেবা কেনার পরে ইনভয়েস এখানে আসবে। ওয়ালেটে টাকা জমা দিলে তার রসিদ ওয়ালেট পাতায় দেখা যায়।",
      action: "ওয়ালেট দেখুন",
    },
    detail: {
      back: "সব ইনভয়েস",
      title: "ইনভয়েস {number}",
      number: "নম্বর",
      date: "তারিখ",
      billedTo: "গ্রাহক",
      noName: "নাম দেওয়া নেই",
      lines: {
        caption: "ইনভয়েসের লাইন",
        description: "বিবরণ",
        amount: "টাকা",
        total: "মোট",
      },
      print: "ছাপুন বা PDF হিসেবে সংরক্ষণ করুন",
      printHint:
        "নতুন পাতায় ইনভয়েসটি খোলে। সেখানে আপনার ব্রাউজারের ছাপার ডায়ালগ থেকে “PDF হিসেবে সংরক্ষণ” বেছে নিন।",
      unavailable: {
        title: "এই ইনভয়েস এখন দেখানো যাচ্ছে না",
        body: "লাইনগুলোর যোগফল মোটের সঙ্গে মেলেনি, তাই ভুল অঙ্ক না দেখিয়ে আমরা থেমেছি। সাপোর্টে লিখুন।",
        action: "সাপোর্টে লিখুন",
      },
    },
  },
} as const;
