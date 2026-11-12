import type { LogEvent } from "@tc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEmailProvider } from "../email/provider";
import type { PlannedRow } from "../queue/notify";
import { runNotifier, type NotifierDeps } from "../queue/run";
import { InMemoryNotifierStore, SMS_DAILY_CAP_DEFAULT } from "../queue/store";
import { InMemorySmsProvider } from "../sms/fake";
import { fixedClock } from "./harness";
import { IDS, SAMPLES } from "./samples";

// WPU-B6, item 29: the daily cap of notification SMS per customer, and store.requeue.
const clock = fixedClock();
let store: InMemoryNotifierStore;
let sms: InMemorySmsProvider;
let logs: LogEvent[];

const deps = (): NotifierDeps => ({
  store,
  email: new InMemoryEmailProvider(),
  sms,
  clock,
  log: (e) => logs.push(e),
  panelOrigin: "https://my.ticoncloud.test",
});

const smsRow = (dedupeKey: string): PlannedRow => ({
  customerId: IDS.customer,
  email: null,
  channel: "sms",
  template: "kyc_approved",
  payload: SAMPLES.kyc_approved.data as PlannedRow["payload"],
  dedupeKey,
});

// An SMS that was sent `hoursAgo` hours before the clock.
function sentBefore(dedupeKey: string, hoursAgo: number): void {
  store.add(smsRow(dedupeKey), clock.now());
  const row = store.rows().find((r) => r.dedupeKey === dedupeKey)!;
  row.status = "sent";
  row.sentAt = new Date(clock.now().getTime() - hoursAgo * 3_600_000);
}

beforeEach(() => {
  clock.set("2026-11-11T10:00:00.000Z");
  store = new InMemoryNotifierStore();
  store.setRecipient(IDS.customer, {
    email: "rahim.uddin@example.test",
    phone: "+8801712345678",
    phoneVerified: true,
    locale: "bn",
    numerals: "beng",
  });
  sms = new InMemorySmsProvider();
  logs = [];
});

describe("the SMS daily cap", () => {
  it("refuses an SMS over the cap with a fixed reason and sends nothing", async () => {
    store.smsCap = 1;
    sentBefore("a", 1);
    store.add(smsRow("b"), clock.now());
    const report = await runNotifier(deps());
    expect(sms.sent).toHaveLength(0);
    expect(report.failed).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "sms_daily_cap" }));
    expect(JSON.stringify(logs)).not.toContain("+8801712345678");
  });

  it("sends within the cap", async () => {
    store.smsCap = 2;
    sentBefore("a", 1);
    store.add(smsRow("b"), clock.now());
    await runNotifier(deps());
    expect(sms.sent).toHaveLength(1);
  });

  it("does not count an SMS sent more than 24 hours ago", async () => {
    store.smsCap = 1;
    sentBefore("a", 25);
    store.add(smsRow("b"), clock.now());
    await runNotifier(deps());
    expect(sms.sent).toHaveLength(1);
  });

  it("counts only the SMS of the same customer", async () => {
    store.smsCap = 1;
    store.add({ ...smsRow("other"), customerId: "other-customer" }, clock.now());
    const other = store.rows().find((r) => r.dedupeKey === "other")!;
    other.status = "sent";
    other.sentAt = new Date(clock.now().getTime() - 3_600_000);
    store.add(smsRow("mine"), clock.now());
    await runNotifier(deps());
    expect(sms.sent).toHaveLength(1);
  });

  it("an unreadable cap is the default of 5, never no cap (R16)", async () => {
    expect(SMS_DAILY_CAP_DEFAULT).toBe(5);
    store.smsDailyCap = () => Promise.reject(new Error("down"));
    for (let i = 0; i < SMS_DAILY_CAP_DEFAULT; i++) sentBefore(`s${i}`, 1);
    store.add(smsRow("next"), clock.now());
    await runNotifier(deps());
    expect(sms.sent).toHaveLength(0);
  });

  it("an unreadable count refuses the row (R16)", async () => {
    store.smsSentSince = () => Promise.reject(new Error("down"));
    store.add(smsRow("a"), clock.now());
    const report = await runNotifier(deps());
    expect(sms.sent).toHaveLength(0);
    expect(report.failed).toBe(1);
  });
});

describe("store.requeue", () => {
  it("makes only a failed row pending again, with zero attempts", async () => {
    store.add(smsRow("a"), clock.now());
    const row = store.rows()[0]!;
    expect(await store.requeue(row.id)).toBe(false); // pending
    row.status = "failed";
    row.attempts = 5;
    expect(await store.requeue(row.id)).toBe(true);
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    row.status = "sent";
    expect(await store.requeue(row.id)).toBe(false); // a sent message is never sent again by this
    expect(await store.requeue("missing")).toBe(false);
  });

  it("a requeued row is tried again by the loop", async () => {
    store.add(smsRow("a"), clock.now());
    const row = store.rows()[0]!;
    row.status = "failed";
    await store.requeue(row.id);
    await runNotifier(deps());
    expect(sms.sent).toHaveLength(1);
  });
});
