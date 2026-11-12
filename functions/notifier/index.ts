// notifier: every minute sends the pending `notifications` rows (3.2).
// This file is the only place that touches the process: environment, clock, console, the database.
//
// Hand-over (JOURNEY.md, WP0-T3): the SES transport. `@aws-sdk/client-sesv2` is not installed (a new
// dependency needs the network and a pinned version), so loadSesTransport() answers null and every
// invocation fails closed (R16) with "notifier: email is not configured" before it touches a row.
// A task with network access writes one SesTransport (SESv2 SendEmail, `Destination.ToAddresses`,
// `Content.Simple` with UTF-8 subject, html and text, `EmailTags`), VERIFY the error names mapped in
// packages/notify/email/provider.ts, and the role has `ses:SendEmail` on the verified identity only
// (infra/stacks/workers.ts). The SMS gateway is not chosen (section 17): SMS rows stay pending.
import { createPgStore } from "@tc/notify";
import type { NotifierReport, SesTransport } from "@tc/notify";
import { withTx } from "@tc/db";
import { buildNotifierHandler, type LambdaContextLike } from "./build";
import { readNotifierConfig } from "./config";

export { createNotifierHandler, STOP_MARGIN_MS } from "./handler";
export type { NotifierHandlerDeps } from "./handler";
export { buildNotifierHandler, withoutChannels } from "./build";
export { readNotifierConfig } from "./config";

export function loadSesTransport(): SesTransport | null {
  return null;
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
    clock: { now: () => new Date() },
    log: (e) => console.log(JSON.stringify(e)),
  });
  return await inner(event, context);
};
