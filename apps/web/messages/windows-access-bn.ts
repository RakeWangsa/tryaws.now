// Namespace `WindowsAccess`: the Windows part of the Access tab (WP6-T1). Bengali first (rule U5).
// No account id, no ARN, no raw AWS text (U6); the password itself is never in a message.
export const windowsAccessBn = {
  WindowsAccess: {
    title: "রিমোট ডেস্কটপ (RDP) দিয়ে সংযোগ",
    intro: "Windows সার্ভারে RDP ক্লায়েন্ট দিয়ে নিচের ইউজার নাম ও পাসওয়ার্ড ব্যবহার করে ঢুকুন।",
    userName: "ইউজার নাম",
    password: "পাসওয়ার্ড",
    show: "পাসওয়ার্ড দেখান",
    working: "পাসওয়ার্ড আনা হচ্ছে…",
    warning:
      "পাসওয়ার্ড একবার দেখানো হয়, ৬০ সেকেন্ড পরে মুছে যায় এবং আমাদের কাছে রাখা হয় না। প্রথমবার ঢুকেই এটি বদলে নিন।",
    gone: "পাসওয়ার্ড লুকিয়ে ফেলা হয়েছে। দরকার হলে আবার দেখান।",
    notReady: "সার্ভার চালু থাকলে তবেই পাসওয়ার্ড দেখা যায়।",
    error: {
      unauthenticated: "সেশন শেষ হয়েছে। আবার সাইন ইন করুন।",
      fresh_sign_in_required: "নিরাপত্তার জন্য আবার সাইন ইন করুন, তারপর চেষ্টা করুন।",
      validation: "অনুরোধটি সঠিক নয়।",
      rate_limited: "অল্প সময়ে অনেক অনুরোধ হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
      not_found: "সার্ভারটি পাওয়া যায়নি।",
      not_ready: "সার্ভার এখনো প্রস্তুত নয়। চালু হলে আবার চেষ্টা করুন।",
      unavailable: "এখন পাসওয়ার্ড আনা গেল না। একটু পরে আবার চেষ্টা করুন।",
    },
  },
} as const;
