import type { diskRestoreBn } from "./disk-restore-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const diskRestoreEn: Same<typeof diskRestoreBn> = {
  DiskRestore: {
    meta: { title: "New disk from a snapshot" },
    heading: "New disk from a snapshot",
    intro:
      "Make a new Amazon Lightsail block storage disk from a snapshot of one of your disks. The new disk is created in the location of the snapshot and is not attached to any server; attach it to a server afterwards.",
    flagOff: {
      title: "Block storage disks are coming soon",
      body: "This service is not open in your market yet. You will be able to use it here once it opens.",
    },
    empty: {
      title: "No snapshot to make a disk from",
      body: "A snapshot of a disk shows here when it is active and a disk price is set for its location.",
    },
    snapshot: "Snapshot",
    snapshotOption: "{name} · {location} · at least {size} GB",
    unnamed: "Unnamed snapshot",
    sourceDestroyed: "Final snapshot of a destroyed disk",
    name: "Name of the new disk",
    hint: "Letters, digits, spaces, dots, hyphens and underscores, up to 60 characters.",
    size: "Size (GB)",
    sizeHint: "A whole number from {min} to {max} GB. It cannot be smaller than the original disk.",
    sizeInvalid: "The size must be a whole number from {min} to {max} GB.",
    price: "Per GB, per month",
    priceNote:
      "The total for your size is shown on the next step. No money is taken until you confirm.",
    snapshotInvalid: "A disk cannot be made from this snapshot right now.",
    regionInvalid: "The location does not match the snapshot.",
    productInvalid: "New disks are not on sale in this location right now.",
    tooSmall: "The new disk cannot be smaller than the original disk.",
    submit: "Go to the next step",
    link: "Make a new disk from a snapshot",
    error: {
      limit_reached: "You have reached your limit.",
      capacity_full: "There is no room in this location right now. Please try again later.",
      kyc_required: "Finish the account setup first: e-mail, mobile number and authenticator.",
      forbidden: "This is not open for you.",
    },
  },
  DiskList: {
    meta: { title: "My disks" },
    heading: "My disks",
    intro:
      "All your Amazon Lightsail block storage disks, in every location, attached to a server or not. A disk that is not attached is still billed until it is destroyed. When a server is destroyed, the disks attached to it are destroyed too.",
    empty: {
      title: "You have no disk",
      body: "Add a new disk from the Storage tab of a server.",
    },
    caption: "All your disks",
    name: "Name",
    size: "Size",
    location: "Location",
    state: "State",
    attachedTo: "Attached to",
    notAttached: "Not attached to a server",
    renewal: "Subscription",
    renewalValue: {
      active: "Active",
      grace: "Renewal due",
      retained: "Being deleted",
      ended: "Ended",
    },
    detach: "Detach",
    stopFirst: "To detach it, unmount the disk first, then stop the server.",
    attachOn: "Attach on {server}",
    unnamedServer: "Unnamed server",
    noTarget: "No server in this location to attach it to.",
    destroy: "Destroy disk",
    destroyTitle: "Destroy this disk?",
    destroyDescription:
      "A final backup of the disk is kept and the disk is destroyed. Type the name of the disk to continue.",
    link: "All my disks",
  },
};
