import type { LogEvent } from "@tc/core";
import {
  InMemoryEmailProvider,
  InMemoryNotifierStore,
  InMemorySmsProvider,
  planRows,
  type NotifierStore,
} from "@tc/notify";
import { expect, it } from "vitest";
import { createNotifierHandler, STOP_MARGIN_MS } from "./handler";

const CUSTOMER = "0193f7c2-5b8a-7c3e-9a1b-1234567890ab";
const build = (store: NotifierStore, over: { remainingMs?: () => number } = {}) => {
  const logs: LogEvent[] = [];
  const email = new InMemoryEmailProvider();
  const handler = createNotifierHandler({
    store,
    email,
    sms: new InMemorySmsProvider(),
    clock: { now: () => new Date("2026-11-11T10:00:00.000Z") },
    log: (e) => logs.push(e),
    panelOrigin: "https://my.ticoncloud.test",
    ...over,
  });
  return { handler, logs, email };
};
const seeded = () => {
  const store = new InMemoryNotifierStore();
  store.setRecipient(CUSTOMER, {
    email: "rahim.uddin@example.test",
    phone: null,
    phoneVerified: false,
    locale: "bn",
    numerals: "beng",
  });
  for (const r of planRows({
    customerId: CUSTOMER,
    template: "welcome",
    data: {},
    dedupeKey: "w",
  })) {
    store.add(r, new Date("2026-11-11T09:00:00.000Z"));
  }
  return store;
};

it("runs the delivery loop once and returns the counts", async () => {
  const { handler, email } = build(seeded());
  expect(await handler({ any: "event" })).toMatchObject({ sent: 2, retry: 0, failed: 0 });
  expect(email.sent).toHaveLength(1);
});

it("stops taking rows near the deadline", async () => {
  const { handler, email } = build(seeded(), { remainingMs: () => STOP_MARGIN_MS - 1 });
  expect(await handler()).toMatchObject({ sent: 0 });
  expect(email.sent).toHaveLength(0);
});

it("a throw is logged with a fixed reason and re-thrown with a fixed message, no cause", async () => {
  const fine = new InMemoryNotifierStore();
  const broken: NotifierStore = {
    due: () => Promise.reject(new Error("connect failed postgres://user:hunter2@host/db")),
    recipient: (id) => fine.recipient(id),
    claim: (id, n) => fine.claim(id, n),
    markSent: (id, now) => fine.markSent(id, now),
    markFailed: (id) => fine.markFailed(id),
    requeue: (id) => fine.requeue(id),
    smsSentSince: (id, since) => fine.smsSentSince(id, since),
    smsDailyCap: () => fine.smsDailyCap(),
  };
  const { handler, logs } = build(broken);
  await expect(handler()).rejects.toThrow("notifier: run failed");
  expect(JSON.stringify(logs)).not.toContain("hunter2");
  expect(logs).toContainEqual({ event: "notifier_run_failed", reason: "run_threw" });
});
