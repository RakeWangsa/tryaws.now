import type { Clock, Logger } from "@tc/core";
import {
  SesEmailProvider,
  type NotifierReport,
  type NotifierStore,
  type SesTransport,
  type SmsProvider,
} from "@tc/notify";
import type { NotifierConfig } from "./config";
import { createNotifierHandler } from "./handler";

// Puts the pieces of one notifier invocation together from ports (3.2). No AWS client is installed:
// the SES call is a SesTransport that a later task injects (JOURNEY.md, WP0-T3 hand-over).
//
// Fail closed (R16):
//   - without an SES transport the run throws before it reads or claims a row, so nothing is burnt;
//   - without an SMS provider (WPU-Z3: the Gennet gateway needs both of its secrets, index.ts), SMS rows
//     are not read at all and stay pending until the gateway is configured, instead of using up their
//     attempts against a provider that cannot send. With one, they are sent like the other channels.

export interface BuildNotifierDeps {
  readonly config: NotifierConfig;
  readonly store: NotifierStore;
  readonly sesTransport: SesTransport | null;
  // The SMS gateway, or null when it is not configured.
  readonly sms: SmsProvider | null;
  readonly clock: Clock;
  readonly log: Logger;
}

// The provider the loop gets for SMS when there is no gateway: it can never send. (The store is then
// wrapped to hide SMS rows, so the loop does not reach it; it stays as the second line.)
const unconfiguredSms: SmsProvider = {
  send: () => Promise.resolve({ ok: false, reason: "unavailable" }),
};

const SMS_FETCH_FACTOR = 4;

// A store that does not return the rows of the given channels. It reads more than `limit` rows so
// that rows of the hidden channel at the head of the queue do not starve the others.
export function withoutChannels(store: NotifierStore, hidden: readonly string[]): NotifierStore {
  return {
    due: async (now, limit) => {
      const rows = await store.due(now, limit * SMS_FETCH_FACTOR);
      return rows.filter((row) => !hidden.includes(row.channel)).slice(0, limit);
    },
    recipient: (id) => store.recipient(id),
    claim: (id, attempts) => store.claim(id, attempts),
    markSent: (id, now) => store.markSent(id, now),
    markFailed: (id) => store.markFailed(id),
    requeue: (id) => store.requeue(id),
    smsSentSince: (id, since) => store.smsSentSince(id, since),
    smsDailyCap: () => store.smsDailyCap(),
  };
}

export interface LambdaContextLike {
  getRemainingTimeInMillis?: () => number;
}

export function buildNotifierHandler(
  deps: BuildNotifierDeps,
): (event?: unknown, context?: LambdaContextLike) => Promise<NotifierReport> {
  return async (event, context) => {
    if (deps.sesTransport === null) {
      deps.log({ event: "notifier_not_configured", channel: "email" });
      throw new Error("notifier: email is not configured");
    }
    const getRemaining = context?.getRemainingTimeInMillis;
    const run = createNotifierHandler({
      store: deps.sms === null ? withoutChannels(deps.store, ["sms"]) : deps.store,
      email: new SesEmailProvider({ transport: deps.sesTransport, from: deps.config.sesFrom }),
      sms: deps.sms ?? unconfiguredSms,
      clock: deps.clock,
      log: deps.log,
      panelOrigin: deps.config.panelOrigin,
      remainingMs:
        typeof getRemaining === "function" ? () => getRemaining.call(context) : undefined,
    });
    return run(event);
  };
}
