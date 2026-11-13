# SMS gateway (Gennet)

The SMS gateway is Gennet, through its white-label "ISMS" API v3 (WPU-Z3): one POST of JSON per message to `https://isms.gennet.com.bd/api/v3/send-sms`. The web app sends the phone OTP at once (`phone_otp` is never queued) and the `notifier` sends the notification SMS (the `sms` rows of `notifications`). Both use `GennetSmsTransport` (`packages/notify/sms/gennet.ts`) behind `GatewaySmsProvider` (`packages/notify/sms/gateway.ts`). Rules: R3 (no secret in the repository, a log, a ticket or a chat), R14 (no full phone number and no SMS text in a log), R16 (fail closed).

## Trigger

- First set-up of the gateway on a stage (staging first, then production).
- A new token or a new sender id (a rotation, see [secret-rotation.md](secret-rotation.md)).
- The phone step of `/verify` says it is not open or to try later, or SMS notifications stay pending or end failed.

## Who

DevOps (a person) sets the secrets and the IP whitelist. The owner holds the login of the Gennet portal. A Claude Code session never reads, prints or sets a secret and never runs `sst secret`.

## The secrets

| SST Secret    | Holds                                       | Linked to         |
| ------------- | ------------------------------------------- | ----------------- |
| `SmsApiKey`   | the `api_token` of the Gennet API           | `web`, `notifier` |
| `SmsSenderId` | the `sid`, the sender id approved by Gennet | `web`, `notifier` |

Set both in your own terminal, per stage, from the Gennet portal. The values are never written down: not in a file, a ticket, a pull request or a chat, and not in this page.

1. `npx sst secret set SmsApiKey <token> --stage staging`
2. `npx sst secret set SmsSenderId <sender id> --stage staging`
3. Deploy the stage (ask first; production only through the CI deploy after approval). A new value applies at the next deploy.

`SmsSenderId` is new with WPU-Z3. Every secret of `infra/lib/functions.ts` needs a value on a stage before its next deploy (VERIFY: a `sst.Secret` without a value fails the deploy with its name). A personal stage without real values gets obviously fake ones: every SMS then fails at the gateway (unauthorized), nothing is sent, and SMS rows end failed after their attempts.

What the code does with them (fail closed, R16):

- Both readable and not empty: the web app on stage staging or production builds the gateway, and the phone OTP works; the notifier sends the SMS rows.
- Either one missing, empty or unreadable: the web app has no OTP service (the phone step of `/verify` shows the "not open" state) and the notifier does not read SMS rows at all, so they stay pending with their attempts intact. Stage local and test never use the real gateway (only `TC_SMS=fake`).

The secrets reach the code as the variables `SST_RESOURCE_SmsApiKey` and `SST_RESOURCE_SmsSenderId` (the convention of `apps/web/server/secrets.ts` and `functions/notifier/secrets.ts`, the same as the database password). VERIFY on the first deploy that SST really sets these variables in the Lambda functions and the Next.js server function; if it does not, SMS stays off (fail closed) and the database password fails the same way.

## IP whitelist

The ISMS API refuses a caller whose address is not whitelisted in the portal (status code 4003 "IP Blacklisted" in the public ISMS Plus v3 documentation; VERIFY for Gennet). Both callers run in the VPC and leave through the NAT, so the addresses to whitelist are the public NAT addresses of the stage, the same addresses as `TC_PROBE_SOURCES` ([pool-account-single.md](pool-account-single.md): two NAT gateways on a full stage; [single-account-lean.md](single-account-lean.md): one NAT instance on a lean stage). Whitelist them in the Gennet portal (the owner logs in). When the NAT addresses change (a new stage, `lean` to `full`), whitelist the new ones before the change.

## First test send (staging)

Only on staging, only to the operator's own phone, never to a customer's number.

1. Both secrets are set, the stage is deployed after they were set, and the NAT addresses are whitelisted.
2. Sign in to the staging panel with a test account, open `/verify`, enter your own mobile number and send the code.
3. Expect within a minute exactly: `MeghVPS Your OTP is: <six digits>. Please do not share your OTP with anyone.` (the provider's OTP format with the brand; the operator's template must match it). Enter the code: the number shows as verified.
4. In the Gennet portal, the sent report shows the message. Where it shows our id of the message (`csms_id`), it is 20 characters of the letters A-Z and the digits 2-7.
5. A notification SMS: approve the identity check of the test account in the admin app (`kyc_approved` has an SMS). The notifier log shows `notifier_sent` with channel `sms` and the row id, never the number or the text.
6. If the code does not come (the page says the phone step is not open, or to try later), check in this order: the two secret names are set on the stage (names only) and the deploy came after them; the IP whitelist; the balance and the sender id in the portal; the portal's report for the status code of the answer.

## VERIFY items (open until the first test send)

Source of what is known: the public ISMS Plus API documentation of SSL Wireless, https://ismsplus.sslwireless.com/api-documentation (read on 2026-11-13; the same field names as the Gennet API the owner described). The Gennet page https://isms.gennet.com.bd/developer/api-info needs the portal login and was not read; the owner can compare it with the items below.

- The answer format. The adapter expects the ISMS Plus v3 answer of SSL Wireless (same field names): JSON with `status` (`SUCCESS` or `FAILED`), `status_code`, `error_message` and `smsinfo` items with `sms_status`, `status_message`, `csms_id` and `reference_id`. Only HTTP 2xx with status `SUCCESS` (and an `smsinfo` item `SUCCESS`) is a sent message. Refused (the number or the text is invalid, the customer sees a field error): status codes 4025, 4027, 4032, an item `INVALID`, a message that names the number or the text as invalid, or HTTP 400, 413 or 422 that names no fault of ours. Everything else is failed (retried by the notifier, "try later" for the OTP): auth, sender id, IP, balance, limits, duplicates, blocked numbers, other HTTP statuses, a body that is not JSON. If Gennet answers differently, sends fail; they are never counted as sent by mistake.
- Duplicate `csms_id`. The notifier derives the `csms_id` from the row id, so a retry of a row has the same id; the OTP derives it from the challenge id, which is sent once. ISMS Plus documents 4023 "Duplicate CMS ID" (and an item `DUPLICATE`); the adapter treats it as failed. After a lost answer the first SMS may have arrived: the retry is then refused as a duplicate and the row ends failed, but no second SMS is sent. Confirm how Gennet answers a repeated `csms_id`.
- The IP whitelist (above), and whether the web function and the notifier really leave through the whitelisted NAT addresses.
- Bengali text. Notification SMS in Bengali are Unicode (ISMS reports `sms_type` `BN`); confirm that Gennet sends them and how it counts the parts. The OTP is always English.
- Limits. ISMS Plus documents 4029 Too Many Requests, 4031 TPS Exceeded and 4033 Too Many OTP Requests. The notifier sends at most 50 rows a run, one after the other, and pauses the SMS channel for the run after 5 failures in a row.
- Rotation. The token and the portal password were once pasted into a chat (JOURNEY.md, owner decisions round 3): the owner rotates both before the first use.

## Stop all SMS at once

Revoke or regenerate the API token in the Gennet portal: every send then fails at the gateway (nothing is sent), at once and without a deploy. The OTP answers "try later", SMS rows are retried and end failed. To start again, set the new token with `npx sst secret set SmsApiKey <token> --stage <stage>` and deploy.

## Log

Date, stage, which secret names were set (never a value), the whitelisted addresses as "NAT addresses of the stage" (not the token), the result of the test send (code received or not, the status code read in the portal).

## Must not

Write a token, a sender id, a portal password or a phone number in the repository, a log, a ticket, a pull request or a chat; test with a customer's number or on production; use the account for bulk SMS or for the OTP of another service (Google, Facebook, WhatsApp and the like are forbidden by the provider); change the OTP text without the provider's template; turn off the IP whitelist to make a test pass.
