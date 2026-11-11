import { shellMessages } from "@tc/ui";
import { galleryMessages } from "@tc/ui/gallery";
import { loadKitMessages } from "@tc/ui/messages";
import { composeMessages } from "@tc/ui/runtime";
import type { Locale, Messages } from "@tc/ui/runtime";
import { bn } from "../messages/bn.ts";
import { en } from "../messages/en.ts";
import { walletBn } from "../messages/wallet-bn.ts";
import { walletEn } from "../messages/wallet-en.ts";
import { serversBn } from "../messages/servers-bn.ts";
import { serversEn } from "../messages/servers-en.ts";
import { kycBn } from "../messages/kyc-bn.ts";
import { kycEn } from "../messages/kyc-en.ts";

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const walletOwn: Readonly<Record<Locale, Messages>> = { bn: walletBn, en: walletEn };
const serversOwn: Readonly<Record<Locale, Messages>> = { bn: serversBn, en: serversEn };
const kycOwn: Readonly<Record<Locale, Messages>> = { bn: kycBn, en: kycEn };

// Kit (`kit`), shell (`Shell`, `Aws`) and app (`Web`, `Wallet`) messages: each owns top-level keys,
// so composing them cannot clash (composeMessages throws on a duplicate namespace).
export const webMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(
    loadKitMessages("bn") as Messages,
    shellMessages.bn,
    appOwn.bn,
    walletOwn.bn,
    serversOwn.bn,
    kycOwn.bn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    walletOwn.en,
    serversOwn.en,
    kycOwn.en,
    galleryMessages.en,
  ),
};
