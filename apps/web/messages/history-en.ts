import type { historyBn } from "./history-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const historyEn: Same<typeof historyBn> = {
  History: {
    tab: "History",
    intro: "The latest requests made on this resource. The newest is first.",
    caption: "Requests made on this resource",
    empty: { title: "No requests yet", body: "A request you make will show here." },
    error: {
      title: "The history cannot be shown now",
      body: "Please try again in a moment. If it stays, write to support.",
    },
    columns: { when: "When", action: "Action", state: "Status" },
    kind: {
      create: "Create",
      suspend: "Suspend",
      resume: "Resume",
      destroy: "Delete",
      reboot: "Reboot",
      stop: "Stop",
      start: "Start",
      rename: "Rename",
      set_ports: "Firewall change",
      attach_static_ip: "Attach static IP",
      detach_static_ip: "Detach static IP",
      create_backup: "Create backup",
      delete_backup: "Delete backup",
      set_auto_backup: "Automatic backups",
      attach_disk: "Attach disk",
      detach_disk: "Detach disk",
      other: "Other change",
    },
    state: {
      queued: "Queued",
      running: "In progress",
      waiting: "Waiting",
      succeeded: "Done",
      failed: "Failed",
      needs_approval: "Waiting for approval",
      needs_attention: "We are looking at it",
    },
  },
};
