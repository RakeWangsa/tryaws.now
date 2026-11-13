import { shellMessages } from "@tc/ui";
import { galleryMessages } from "@tc/ui/gallery";
import { loadKitMessages } from "@tc/ui/messages";
import { composeMessages } from "@tc/ui/runtime";
import type { Locale, Messages } from "@tc/ui/runtime";
import { adminsBn } from "../messages/admins.ts";
import { adminsEn } from "../messages/admins.en.ts";
import { auditBn } from "../messages/audit.ts";
import { auditEn } from "../messages/audit.en.ts";
import { bn } from "../messages/bn.ts";
import { customersBn } from "../messages/customers.ts";
import { customersEn } from "../messages/customers.en.ts";
import { en } from "../messages/en.ts";
import { moneyBn } from "../messages/money.ts";
import { moneyEn } from "../messages/money.en.ts";
import { configPriceBn } from "../messages/configprice.ts";
import { configPriceEn } from "../messages/configprice.en.ts";
import { invoiceSellerBn } from "../messages/invoiceseller.ts";
import { invoiceSellerEn } from "../messages/invoiceseller.en.ts";
import { tierLimitsBn } from "../messages/tierlimits.ts";
import { tierLimitsEn } from "../messages/tierlimits.en.ts";
import { priceBookBn } from "../messages/pricebook.ts";
import { priceBookEn } from "../messages/pricebook.en.ts";
import { pricingBn } from "../messages/pricing.ts";
import { pricingEn } from "../messages/pricing.en.ts";
import { planChangeBn } from "../messages/planchange.ts";
import { planChangeEn } from "../messages/planchange.en.ts";
import { renewalsBn } from "../messages/renewals.ts";
import { renewalsEn } from "../messages/renewals.en.ts";
import { opsBn } from "../messages/ops.ts";
import { opsEn } from "../messages/ops.en.ts";
import { casesBn } from "../messages/cases.ts";
import { casesEn } from "../messages/cases.en.ts";
import { unpaidRuleBn } from "../messages/unpaidrule.ts";
import { unpaidRuleEn } from "../messages/unpaidrule.en.ts";

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const customers: Readonly<Record<Locale, Messages>> = { bn: customersBn, en: customersEn };
const money: Readonly<Record<Locale, Messages>> = { bn: moneyBn, en: moneyEn };
const ops: Readonly<Record<Locale, Messages>> = { bn: opsBn, en: opsEn };
const cases: Readonly<Record<Locale, Messages>> = { bn: casesBn, en: casesEn };

// The kit owns only the top-level key `kit`, so composing it with Shell, Aws and Admin cannot clash.
export const adminMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(
    loadKitMessages("bn") as Messages,
    shellMessages.bn,
    appOwn.bn,
    customers.bn,
    money.bn,
    pricingBn,
    priceBookBn,
    configPriceBn,
    tierLimitsBn,
    invoiceSellerBn,
    ops.bn,
    planChangeBn,
    renewalsBn,
    unpaidRuleBn,
    auditBn,
    adminsBn,
    cases.bn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    customers.en,
    money.en,
    pricingEn,
    priceBookEn,
    configPriceEn,
    tierLimitsEn,
    invoiceSellerEn,
    ops.en,
    planChangeEn,
    renewalsEn,
    unpaidRuleEn,
    auditEn,
    adminsEn,
    cases.en,
    galleryMessages.en,
  ),
};
