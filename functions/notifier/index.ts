// notifier: every minute sends the pending `notifications` rows (3.2).
//
// Not wired here (hand-over in JOURNEY.md, WP5-T5): the SES transport (`@aws-sdk/client-sesv2`
// SendEmail, a new dependency that needs the network to install and a pinned version, VERIFY the
// error names mapped in packages/notify/email/provider.ts), the SMS gateway transport (section 17:
// the provider is not chosen), the schedule (EventBridge, rate(1 minute)), the `SmsApiKey` link,
// the role (`ses:SendEmail` on the verified identity, DB user worker_rw) and `readConfig` of the
// panel origin and the sender. Until then the handler is not exported as `handler`, so a deploy
// without the wiring fails closed (R16).
export { createNotifierHandler, STOP_MARGIN_MS } from "./handler";
export type { NotifierHandlerDeps } from "./handler";
