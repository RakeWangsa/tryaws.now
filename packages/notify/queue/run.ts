import type { Clock, Locale, Logger } from "@tc/core";
import type { EmailProvider } from "../email/provider";
import type { SmsProvider } from "../sms/provider";
import { scanSecrets } from "../text/guards";
import { isTemplateId, parseTemplateData, renderEmail, renderSms } from "../templates/render";
import {
  MAX_ATTEMPTS,
  SMS_DAILY_CAP_DEFAULT,
  SMS_DAILY_WINDOW_MS,
  type NotifierStore,
  type Recipient,
  type StoredRow,
} from "./store";
import type { Channel } from "./types";

export { MAX_ATTEMPTS };

// The delivery loop that the `notifier` function calls once a minute (3.2): read the pending rows
// that are due, render them in the customer's language, send them and mark them.
//
// "Sends once" is at-least-once with a guard: a row is claimed by a compare-and-set on `attempts`
// before the send, so two overlapping runs send a row once. A crash between the send and the mark
// can send it again after the backoff; a lost security alert or receipt is worse than a rare
// duplicate (open point 4). No network call runs inside a transaction: every store call is its own.
//
// R14: the logs hold counts, ids of rows, channel names, template ids and fixed reasons. Never an
// address, a phone number, a subject, a body or the text of an error.

export interface NotifierDeps {
  readonly store: NotifierStore;
  readonly email: EmailProvider;
  readonly sms: SmsProvider;
  readonly clock: Clock;
  readonly log: Logger;
  // https origin of the panel; links in a message are built from it (16.14).
  readonly panelOrigin: string;
  readonly limit?: number;
  // True when the invocation is about to run out of time (the Lambda deadline).
  readonly shouldStop?: () => boolean;
}

export interface NotifierReport {
  readonly sent: number;
  readonly retry: number;
  readonly failed: number;
  readonly skipped: number;
  readonly paused: readonly Channel[];
}

const DEFAULT_LIMIT = 50;
// After this many failures in a row a channel rests for the rest of the run: a provider outage must
// not burn the attempts of every row in one minute.
const PAUSE_AFTER = 5;

export async function runNotifier(deps: NotifierDeps): Promise<NotifierReport> {
  const { store, clock, log } = deps;
  const counts = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  const streak = new Map<Channel, number>();
  const paused = new Set<Channel>();

  // The SMS cap per customer and day is read once per run and only when an SMS row is met. A cap
  // that cannot be read is the default, never "no cap" (R16).
  let smsCap: number | null = null;
  const capOf = async (): Promise<number> => {
    if (smsCap === null) {
      try {
        smsCap = await store.smsDailyCap();
      } catch {
        smsCap = SMS_DAILY_CAP_DEFAULT;
      }
    }
    return smsCap;
  };

  const rows = await store.due(clock.now(), deps.limit ?? DEFAULT_LIMIT);

  // A row that can never be sent is failed with no attempt ("never tried") and a logged reason.
  const refuse = async (row: StoredRow, reason: string): Promise<void> => {
    await store.markFailed(row.id);
    counts.failed += 1;
    log({
      event: "notifier_refused",
      row: row.id,
      channel: row.channel,
      template: row.template,
      reason,
    });
  };

  for (const row of rows) {
    if (deps.shouldStop?.() === true) break;
    if (paused.has(row.channel)) {
      counts.skipped += 1;
      continue;
    }
    if (!isTemplateId(row.template)) {
      await refuse(row, "unknown_template");
      continue;
    }
    let data;
    try {
      data = parseTemplateData(row.template, row.payload);
    } catch {
      await refuse(row, "bad_payload");
      continue;
    }

    // The bell needs no provider: the item exists as soon as its row exists.
    if (row.channel === "in_app") {
      if (row.customerId === null) {
        await refuse(row, "no_customer");
        continue;
      }
      if (!(await store.claim(row.id, row.attempts))) continue;
      await finish(row, { ok: true });
      continue;
    }

    let recipient: Recipient | null = null;
    if (row.customerId !== null) {
      recipient = await store.recipient(row.customerId);
      if (recipient === null) {
        await refuse(row, "no_customer");
        continue;
      }
    }
    const locale: Locale = recipient?.locale ?? "bn";
    const numerals = recipient?.numerals ?? "beng";
    const ctx = { locale, numerals, panelOrigin: deps.panelOrigin };

    let send: () => Promise<{ ok: true } | { ok: false; reason: "rejected" | "unavailable" }>;
    try {
      if (row.channel === "email") {
        const to = row.email ?? recipient?.email ?? null;
        if (to === null) {
          await refuse(row, "no_address");
          continue;
        }
        const rendered = renderEmail(row.template, data, ctx);
        const rule = scanSecrets(`${rendered.subject}\n${rendered.text}`);
        if (rule !== null) {
          await refuse(row, rule);
          continue;
        }
        send = () => deps.email.send({ to, ...rendered, tag: row.template });
      } else {
        if (recipient === null || recipient.phone === null || !recipient.phoneVerified) {
          await refuse(row, "no_verified_phone");
          continue;
        }
        // The daily cap: a customer gets at most `cap` notification SMS in 24 hours. The row is
        // refused, not delayed: the same event also has an in-app item and usually an e-mail.
        if (row.customerId !== null) {
          const since = new Date(clock.now().getTime() - SMS_DAILY_WINDOW_MS);
          let sentToday: number;
          try {
            sentToday = await store.smsSentSince(row.customerId, since);
          } catch {
            await refuse(row, "sms_cap_unreadable");
            continue;
          }
          if (sentToday >= (await capOf())) {
            await refuse(row, "sms_daily_cap");
            continue;
          }
        }
        const to = recipient.phone;
        const text = renderSms(row.template, data, ctx);
        if (text === null) {
          await refuse(row, "no_sms_text");
          continue;
        }
        const rule = scanSecrets(text);
        if (rule !== null) {
          await refuse(row, rule);
          continue;
        }
        send = () => deps.sms.send(to, text);
      }
    } catch {
      await refuse(row, "render_failed");
      continue;
    }

    if (!(await store.claim(row.id, row.attempts))) continue;
    let result: { ok: true } | { ok: false; reason: "rejected" | "unavailable" };
    try {
      result = await send();
    } catch {
      // The provider's error may carry the address or the text: it is dropped here (R14).
      result = { ok: false, reason: "unavailable" };
      log({ event: "notifier_provider_threw", row: row.id, channel: row.channel });
    }
    await finish(row, result);
  }

  async function finish(
    row: StoredRow,
    result: { ok: true } | { ok: false; reason: "rejected" | "unavailable" },
  ): Promise<void> {
    const attempts = row.attempts + 1;
    if (result.ok) {
      streak.set(row.channel, 0);
      try {
        await store.markSent(row.id, clock.now());
      } catch {
        // Sent but not marked: it will go again after the backoff (at-least-once).
        log({ event: "notifier_mark_failed", row: row.id, channel: row.channel });
        return;
      }
      counts.sent += 1;
      log({
        event: "notifier_sent",
        row: row.id,
        channel: row.channel,
        template: row.template,
        attempts,
      });
      return;
    }
    if (result.reason === "rejected" || attempts >= MAX_ATTEMPTS) {
      await store.markFailed(row.id);
      counts.failed += 1;
      log({
        event: "notifier_failed",
        row: row.id,
        channel: row.channel,
        template: row.template,
        reason: result.reason,
        attempts,
      });
    } else {
      counts.retry += 1;
      log({
        event: "notifier_retry",
        row: row.id,
        channel: row.channel,
        template: row.template,
        attempts,
      });
    }
    if (result.reason === "unavailable") {
      const n = (streak.get(row.channel) ?? 0) + 1;
      streak.set(row.channel, n);
      if (n >= PAUSE_AFTER) paused.add(row.channel);
    }
  }

  const report: NotifierReport = { ...counts, paused: [...paused] };
  log({
    event: "notifier_run",
    sent: report.sent,
    retry: report.retry,
    failed: report.failed,
    skipped: report.skipped,
    due: rows.length,
  });
  return report;
}
