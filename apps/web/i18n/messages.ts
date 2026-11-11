import { shellMessages } from "@tc/ui";
import { composeMessages } from "@tc/ui/runtime";
import type { Locale, Messages } from "@tc/ui/runtime";
import { bn } from "../messages/bn.ts";
import { en } from "../messages/en.ts";

const appOwn: Readonly<Record<Locale, Messages>> = { bn, en };

// The kit messages (`kit` namespace, loadKitMessages of @tc/ui/messages) join here once the kit is
// merged. The kit owns only the top-level key `kit`, so composing it later cannot clash.
export const webMessages: Readonly<Record<Locale, Messages>> = {
  bn: composeMessages(shellMessages.bn, appOwn.bn),
  en: composeMessages(shellMessages.en, appOwn.en),
};
