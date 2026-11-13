import { secretValue, sstLinks, type LinkSource } from "@tc/db/links";

// The secrets of the web app (EPS, the keys, the SMS gateway) reach it only through this port (R3).
// WPU-Z15: at run time they are read through the SST SDK. SST 4.17.2 hands the Next.js server its links
// through the wrapper that decrypts the encrypted link file into globalThis.SST_KEY_FILE_DATA (the
// SST_RESOURCE_<Name> variables exist for `next build` only), and the SDK's Resource reads that and
// every other delivery path (`sst dev` sets SST_RESOURCE_<Name>). The links are read through
// @tc/db/links, the one reader of linked values. A secret is read when asked for and
// is never held in a module constant; an unreadable one is `undefined`, and the caller fails closed
// (R16). WPU-Z3: SmsApiKey (the Gennet api_token) and SmsSenderId (the sid), for the phone OTP.

export type SecretName =
  | "EpsMerchantId"
  | "EpsStoreId"
  | "EpsUsername"
  | "EpsPassword"
  | "EpsHashKey"
  | "EpsLimitKey"
  | "OrderDraftSecret"
  | "AuthLimitKey"
  | "OtpHashKey"
  | "SmsApiKey"
  | "SmsSenderId";

export type SecretSource = (name: SecretName) => string | undefined;

// WPU-Z11: the value a person stores for a secret that is deliberately not configured yet. SST needs a
// value for every declared secret before a deploy, so scripts/golive/stage-secrets.sh stores this
// literal for each EPS value the owner leaves empty (the EPS production keys come later). It reads as no
// value: the caller fails closed exactly as for a missing secret, so with an EPS value on the placeholder
// there is no EPS, every top-up says "not open" and nothing is sent to EPS (R6, R16).
export const NOT_CONFIGURED = "not-configured";

// Each secret is the `value` of its linked sst.Secret when it is a string that is not empty (secretValue)
// and not the placeholder.
export function linkedSecrets(links: LinkSource = sstLinks): SecretSource {
  return (name) => {
    const value = secretValue(links(name));
    return value === NOT_CONFIGURED ? undefined : value;
  };
}
