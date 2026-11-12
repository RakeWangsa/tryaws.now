// notifier: every minute sends the pending `notifications` rows (3.2).
// This file is the only place that touches the process: environment, clock, console, the database.
//
// WPU-D4: the SES transport is ses.ts (SESv2 SendEmail). Without a valid SES_IDENTITY_ARN
// loadSesTransport() answers null and every invocation fails closed (R16) with "notifier: email is not
// configured" before it touches a row. The role has `ses:SendEmail` on the verified identity only
// (infra/stacks/workers.ts). The SMS gateway is not chosen (section 17): SMS rows stay pending.
import { createPgStore } from "@tc/notify";
import type { NotifierReport, SesTransport } from "@tc/notify";
import { withTx } from "@tc/db";
import { buildNotifierHandler, type LambdaContextLike } from "./build";
import { readNotifierConfig } from "./config";
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
