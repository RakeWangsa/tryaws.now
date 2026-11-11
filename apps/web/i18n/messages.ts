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

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const walletOwn: Readonly<Record<Locale, Messages>> = { bn: walletBn, en: walletEn };
const serversOwn: Readonly<Record<Locale, Messages>> = { bn: serversBn, en: serversEn };
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
    authOwn.bn,
    kycOwn.bn,
    settingsOwn.bn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    walletOwn.en,
    serversOwn.en,
    windowsAccessEn,
    authOwn.en,
    kycOwn.en,
    settingsOwn.en,
    galleryMessages.en,
  ),
};
