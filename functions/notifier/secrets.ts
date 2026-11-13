import { configuredSecretValue, type LinkSource } from "@tc/db/links";

// WPU-Z3: the two secrets of the SMS gateway reach the notifier only through this reader (R3): SmsApiKey
// (the Gennet api_token) and SmsSenderId (the sid). A secret is read when asked for and is never held in
// a module constant; an unreadable or empty one is `undefined`, and the caller then keeps SMS off (R16).
// No value is logged or thrown (R3, R14).
//
// WPU-Z15: at run time the secrets are read through the SST SDK. SST 4.17.2 hands a deployed function
// its links only in an encrypted file (SST_KEY_FILE, SST_KEY), which the SDK's Resource decrypts; only
// `sst dev` sets the variables SST_RESOURCE_<Name>. The links are read through @tc/db/links, the one
// reader of linked values.

export type NotifierSecretName = "SmsApiKey" | "SmsSenderId";

// The `value` of the linked sst.Secret, when it is a string that is not empty and not the placeholder
// `not-configured` (final review M2): the owner may leave both SMS secrets on it, which is "SMS off", and the
// placeholder must never reach Gennet as a token or a sender id.
export function linkedSecret(links: LinkSource, name: NotifierSecretName): string | undefined {
  return configuredSecretValue(links(name));
}
