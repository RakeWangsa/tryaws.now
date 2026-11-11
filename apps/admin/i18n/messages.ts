import { shellMessages } from "@tc/ui";
import { galleryMessages } from "@tc/ui/gallery";
import { loadKitMessages } from "@tc/ui/messages";
import { composeMessages } from "@tc/ui/runtime";
import type { Locale, Messages } from "@tc/ui/runtime";
import { bn } from "../messages/bn.ts";
import { customersBn } from "../messages/customers.ts";
import { customersEn } from "../messages/customers.en.ts";
import { en } from "../messages/en.ts";

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const customers: Readonly<Record<Locale, Messages>> = { bn: customersBn, en: customersEn };

// The kit owns only the top-level key `kit`, so composing it with Shell, Aws and Admin cannot clash.
export const adminMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(
    loadKitMessages("bn") as Messages,
    shellMessages.bn,
    appOwn.bn,
    customers.bn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    customers.en,
    galleryMessages.en,
  ),
};
