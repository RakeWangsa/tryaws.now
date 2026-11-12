import { shellMessages } from "@tc/ui";
import { galleryMessages } from "@tc/ui/gallery";
import { loadKitMessages } from "@tc/ui/messages";
import { composeMessages } from "@tc/ui/runtime";
import type { Locale, Messages } from "@tc/ui/runtime";
import { authBn } from "../messages/auth-bn.ts";
import { authEn } from "../messages/auth-en.ts";
import { bn } from "../messages/bn.ts";
import { en } from "../messages/en.ts";
import { walletBn } from "../messages/wallet-bn.ts";
import { walletEn } from "../messages/wallet-en.ts";
import { serversBn } from "../messages/servers-bn.ts";
import { serversEn } from "../messages/servers-en.ts";
import { kycBn } from "../messages/kyc-bn.ts";
import { kycEn } from "../messages/kyc-en.ts";
import { settingsBn } from "../messages/settings-bn.ts";
import { settingsEn } from "../messages/settings-en.ts";
import { windowsAccessBn } from "../messages/windows-access-bn.ts";
import { windowsAccessEn } from "../messages/windows-access-en.ts";
import { extrasBn } from "../messages/extras-bn.ts";
import { extrasEn } from "../messages/extras-en.ts";
import { cdnBn } from "../messages/cdn-bn.ts";
import { cdnEn } from "../messages/cdn-en.ts";
import { databasesBn } from "../messages/databases-bn.ts";
import { databasesEn } from "../messages/databases-en.ts";
import { loadBalancersBn } from "../messages/load-balancers-bn.ts";
import { loadBalancersEn } from "../messages/load-balancers-en.ts";
import { bucketBn } from "../messages/bucket-bn.ts";
import { bucketEn } from "../messages/bucket-en.ts";
import { containerBn } from "../messages/container-bn.ts";
import { containerEn } from "../messages/container-en.ts";
import { publicBn } from "../messages/public-bn.ts";
import { publicEn } from "../messages/public-en.ts";
import { domainsBn } from "../messages/domains-bn.ts";
import { domainsEn } from "../messages/domains-en.ts";
import { supportBn } from "../messages/support-bn.ts";
import { supportEn } from "../messages/support-en.ts";

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const walletOwn: Readonly<Record<Locale, Messages>> = { bn: walletBn, en: walletEn };
const serversOwn: Readonly<Record<Locale, Messages>> = { bn: serversBn, en: serversEn };
const extrasOwn: Readonly<Record<Locale, Messages>> = { bn: extrasBn, en: extrasEn };
const authOwn: Readonly<Record<Locale, Messages>> = { bn: authBn, en: authEn };
const kycOwn: Readonly<Record<Locale, Messages>> = { bn: kycBn, en: kycEn };
const settingsOwn: Readonly<Record<Locale, Messages>> = { bn: settingsBn, en: settingsEn };

// Kit (`kit`), shell (`Shell`, `Aws`) and app (`Web`, `Wallet`, `Auth`) messages: each owns top-level keys,
// so composing them cannot clash (composeMessages throws on a duplicate namespace).
export const webMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(
    loadKitMessages("bn") as Messages,
    shellMessages.bn,
    appOwn.bn,
    walletOwn.bn,
    serversOwn.bn,
    windowsAccessBn,
    extrasOwn.bn,
    cdnBn,
    databasesBn,
    loadBalancersBn,
    bucketBn,
    containerBn,
    domainsBn,
    authOwn.bn,
    kycOwn.bn,
    settingsOwn.bn,
    supportBn,
    publicBn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    walletOwn.en,
    serversOwn.en,
    windowsAccessEn,
    extrasOwn.en,
    cdnEn,
    databasesEn,
    loadBalancersEn,
    bucketEn,
    containerEn,
    domainsEn,
    authOwn.en,
    kycOwn.en,
    settingsOwn.en,
    supportEn,
    publicEn,
    galleryMessages.en,
  ),
};
