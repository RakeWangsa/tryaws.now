// WPU-N1: the History tab of a resource. One line for each request the customer (or the service for
// them) made on it. No raw error and no internal step is shown (U6).
export const historyBn = {
  History: {
    tab: "ইতিহাস",
    intro: "এই রিসোর্সের উপর করা সাম্প্রতিক অনুরোধ। নতুনটি ওপরে।",
    caption: "রিসোর্সের অনুরোধের তালিকা",
    empty: { title: "এখনও কোনো অনুরোধ নেই", body: "অনুরোধ করলে এখানে দেখা যাবে।" },
    error: {
      title: "ইতিহাস এখন দেখানো যাচ্ছে না",
      body: "একটু পরে আবার চেষ্টা করুন। সমস্যা থাকলে সাপোর্টে লিখুন।",
    },
    columns: { when: "কখন", action: "কাজ", state: "অবস্থা" },
    kind: {
      create: "তৈরি",
      suspend: "স্থগিত",
      resume: "আবার চালু",
      destroy: "মুছে ফেলা",
      reboot: "রিবুট",
      stop: "বন্ধ করা",
      start: "চালু করা",
      rename: "নাম বদল",
      set_ports: "ফায়ারওয়াল পরিবর্তন",
      attach_static_ip: "স্ট্যাটিক আইপি যুক্ত করা",
      detach_static_ip: "স্ট্যাটিক আইপি সরানো",
      create_backup: "ব্যাকআপ তৈরি",
      delete_backup: "ব্যাকআপ মুছে ফেলা",
      set_auto_backup: "স্বয়ংক্রিয় ব্যাকআপ",
      attach_disk: "ডিস্ক যুক্ত করা",
      detach_disk: "ডিস্ক সরানো",
      other: "অন্য পরিবর্তন",
    },
    state: {
      queued: "সারিতে আছে",
      running: "চলছে",
      waiting: "অপেক্ষায়",
      succeeded: "সম্পন্ন",
      failed: "ব্যর্থ",
      needs_approval: "অনুমোদনের অপেক্ষায়",
      needs_attention: "আমরা দেখছি",
    },
  },
};
