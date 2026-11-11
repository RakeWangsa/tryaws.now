import { shellMessages } from "@tc/ui";
import { galleryMessages } from "@tc/ui/gallery";
import { loadKitMessages } from "@tc/ui/messages";
import { composeMessages } from "@tc/ui/runtime";
import type { Locale, Messages } from "@tc/ui/runtime";
import { bn } from "../messages/bn.ts";
import { customersBn } from "../messages/customers.ts";
import { customersEn } from "../messages/customers.en.ts";
import { en } from "../messages/en.ts";
import { moneyBn } from "../messages/money.ts";
import { moneyEn } from "../messages/money.en.ts";
import { pricingBn } from "../messages/pricing.ts";
import { pricingEn } from "../messages/pricing.en.ts";

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const customers: Readonly<Record<Locale, Messages>> = { bn: customersBn, en: customersEn };
const money: Readonly<Record<Locale, Messages>> = { bn: moneyBn, en: moneyEn };

// The kit owns only the top-level key `kit`, so composing it with Shell, Aws and Admin cannot clash.
export const adminMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(
    loadKitMessages("bn") as Messages,
    shellMessages.bn,
    appOwn.bn,
    customers.bn,
    money.bn,
    pricingBn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    customers.en,
    money.en,
    pricingEn,
    galleryMessages.en,
  ),
};
