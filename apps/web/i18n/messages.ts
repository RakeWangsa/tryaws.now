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

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };
const walletOwn: Readonly<Record<Locale, Messages>> = { bn: walletBn, en: walletEn };
const authOwn: Readonly<Record<Locale, Messages>> = { bn: authBn, en: authEn };

// Kit (`kit`), shell (`Shell`, `Aws`) and app (`Web`, `Wallet`, `Auth`) messages: each owns top-level keys,
// so composing them cannot clash (composeMessages throws on a duplicate namespace).
export const webMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(
    loadKitMessages("bn") as Messages,
    shellMessages.bn,
    appOwn.bn,
    walletOwn.bn,
    authOwn.bn,
    galleryMessages.bn,
  ),
  en: composeMessages(
    loadKitMessages("en") as Messages,
    shellMessages.en,
    appOwn.en,
    walletOwn.en,
    authOwn.en,
    galleryMessages.en,
  ),
};
