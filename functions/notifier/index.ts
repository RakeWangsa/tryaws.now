// notifier: every minute sends the pending `notifications` rows (3.2).
// This file is the only place that touches the process: environment, clock, console, the database.
//
// WPU-D4: the SES transport is ses.ts (SESv2 SendEmail). Without a valid SES_IDENTITY_ARN
// loadSesTransport() answers null and every invocation fails closed (R16) with "notifier: email is not
// configured" before it touches a row. The role has `ses:SendEmail` on the verified identity only
// (infra/stacks/workers.ts).
// WPU-Z3: the SMS gateway is Gennet (ISMS API v3, packages/notify/sms/gennet.ts). Without both linked
// secrets SmsApiKey and SmsSenderId loadSmsProvider() answers null and SMS rows stay pending (R16).
import { GatewaySmsProvider, GennetSmsTransport, createPgStore } from "@tc/notify";
import type { NotifierReport, SesTransport, SmsProvider } from "@tc/notify";
import { withTx } from "@tc/db";
import { buildNotifierHandler, type LambdaContextLike } from "./build";
import { readNotifierConfig } from "./config";
import { sstLinks, type LinkSource } from "@tc/db/links";
import { linkedSecret } from "./secrets";
import { sesTransportFromEnv } from "./ses";

export { createNotifierHandler, STOP_MARGIN_MS } from "./handler";
export type { NotifierHandlerDeps } from "./handler";
export { buildNotifierHandler, withoutChannels } from "./build";
export { readNotifierConfig } from "./config";

export function loadSesTransport(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SesTransport | null {
  return sesTransportFromEnv(env);
}

// The Gennet gateway when both of its secrets are readable, else null. Builds no connection. The links
// default to the SST SDK, the run-time path of a deployed function (WPU-Z15).
export function loadSmsProvider(links: LinkSource = sstLinks): SmsProvider | null {
  const apiToken = linkedSecret(links, "SmsApiKey");
  const senderId = linkedSecret(links, "SmsSenderId");
  if (apiToken === undefined || senderId === undefined) return null;
  return new GatewaySmsProvider({ transport: new GennetSmsTransport({ apiToken, senderId }) });
}

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ReturnType<typeof buildNotifierHandler> | undefined;

export const handler = async (
  event?: unknown,
  context?: LambdaContextLike,
): Promise<NotifierReport> => {
  inner ??= buildNotifierHandler({
    config: readNotifierConfig(process.env),
    store: createPgStore(withTx),
    sesTransport: loadSesTransport(),
    sms: loadSmsProvider(),
    clock: { now: () => new Date() },
    log: (e) => console.log(JSON.stringify(e)),
  });
  return await inner(event, context);
};
