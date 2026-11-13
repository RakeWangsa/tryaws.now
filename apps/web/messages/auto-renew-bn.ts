// Namespace `AutoRenew`: the auto-renew switch of the detail page of every family that has no switch of
// its own (WPU-Z14). Bengali first (rule U5). Fixed texts for fixed keys (U6).
export const autoRenewBn = {
  AutoRenew: {
    title: "স্বয়ংক্রিয় নবায়ন",
    column: "স্বয়ংক্রিয় নবায়ন",
    on: "চালু",
    off: "বন্ধ",
    hint: "চালু থাকলে এই মেয়াদ শেষে পরবর্তী মেয়াদ আপনার ওয়ালেট থেকে পরিশোধ হয়। বন্ধ থাকলে আপনার সম্মতি ছাড়া কোনো টাকা কাটা হয় না; মেয়াদ শেষে সেবাটি স্থগিত হয়।",
    notNow: "এখনকার অবস্থায় স্বয়ংক্রিয় নবায়ন চালু করা যায় না।",
    turnOn: "স্বয়ংক্রিয় নবায়ন চালু করুন",
    turnOff: "স্বয়ংক্রিয় নবায়ন বন্ধ করুন",
    done: {
      autoRenewOn: "স্বয়ংক্রিয় নবায়ন চালু হয়েছে।",
      autoRenewOff: "স্বয়ংক্রিয় নবায়ন বন্ধ হয়েছে। মেয়াদ শেষে সেবাটি স্থগিত হবে।",
    },
    error: {
      unauthenticated: "আপনার সেশন শেষ হয়েছে। আবার সাইন ইন করুন।",
      flag_off: "এই সেবা আপনার জন্য এখনও চালু হয়নি।",
      validation: "অনুরোধটি সঠিক নয়। পাতাটি আবার খুলে চেষ্টা করুন।",
      rate_limited: "অল্প সময়ে অনেক অনুরোধ হয়েছে। একটু পরে আবার চেষ্টা করুন।",
      not_found: "এটি খুঁজে পাওয়া যায়নি।",
      not_allowed: "এখনকার অবস্থায় এটি করা যায় না।",
      unavailable: "এখন এটি করা গেল না। একটু পরে আবার চেষ্টা করুন।",
    },
  },
} as const;
