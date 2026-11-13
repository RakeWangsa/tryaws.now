import { beforeEach, describe, expect, it } from "vitest";
import type { LogEvent } from "@tc/core";
import { InMemoryEmailProvider } from "../email/provider";
import { planRows } from "../queue/notify";
import { MAX_ATTEMPTS, runNotifier, type NotifierDeps } from "../queue/run";
import { InMemoryNotifierStore } from "../queue/store";
import { TEMPLATE_IDS, type TemplateId } from "../queue/types";
import { InMemorySmsProvider } from "../sms/fake";
import type { SmsProvider, SmsSendResult } from "../sms/provider";
import { scanSecrets } from "../text/guards";
import { fixedClock } from "./harness";
import { IDS, SAMPLES } from "./samples";

const EMAIL = "rahim.uddin@example.test";
const PHONE = "+8801712345678";
const OLD_EMAIL = "old.address@example.test";

let store: InMemoryNotifierStore;
let email: InMemoryEmailProvider;
let sms: InMemorySmsProvider;
let logs: LogEvent[];
const clock = fixedClock();

const deps = (over: Partial<NotifierDeps> = {}): NotifierDeps => ({
  store,
  email,
  sms,
  clock,
  log: (e) => logs.push(e),
  panelOrigin: "https://my.ticoncloud.test",
  ...over,
});
const queue = (template: TemplateId, extra: { email?: string; customerId?: string } = {}) => {
  const rows = planRows({
    customerId: IDS.customer,
    ...extra,
    template,
    data: SAMPLES[template].data,
    dedupeKey: "k1",
  });
  for (const r of rows) store.add(r, clock.now());
  return rows;
};

beforeEach(() => {
  clock.set("2026-11-11T10:00:00.000Z");
  store = new InMemoryNotifierStore();
  store.setRecipient(IDS.customer, {
    email: EMAIL,
    phone: PHONE,
    phoneVerified: true,
    locale: "bn",
    numerals: "beng",
  });
  email = new InMemoryEmailProvider();
  sms = new InMemorySmsProvider();
  logs = [];
});

describe.each(TEMPLATE_IDS)("trigger %s", (id) => {
  it.each(["bn", "en"] as const)(
    "sends once per channel in %s, and a second run sends nothing",
    async (locale) => {
      store.setRecipient(IDS.customer, {
        email: EMAIL,
        phone: PHONE,
        phoneVerified: true,
        locale,
        numerals: "beng",
      });
      queue(id);
      const first = await runNotifier(deps());
      const channels = SAMPLES[id].channels;
      expect(email.sent).toHaveLength(channels.includes("email") ? 1 : 0);
      expect(sms.sent).toHaveLength(channels.includes("sms") ? 1 : 0);
      expect(first.sent).toBe(channels.length);
      expect(store.rows().every((r) => r.status === "sent" && r.sentAt !== null)).toBe(true);
      // a second run, and a third after the backoff, change nothing
      await runNotifier(deps());
      clock.advanceSeconds(3600);
      await runNotifier(deps());
      expect(email.sent).toHaveLength(channels.includes("email") ? 1 : 0);
      expect(sms.sent).toHaveLength(channels.includes("sms") ? 1 : 0);
      if (email.sent[0]) expect(email.sent[0].to).toBe(EMAIL);
      if (sms.sent[0]) expect(sms.sent[0].to).toBe(PHONE);
    },
  );

  it("holds no secret, and no phone or address of the customer, in any message or log", async () => {
    queue(id);
    await runNotifier(deps());
    for (const m of email.sent) {
      expect(scanSecrets(m.subject)).toBeNull();
      expect(m.text).not.toContain(PHONE);
      expect(m.html).not.toContain(PHONE);
      expect(m.html + m.text).not.toContain(EMAIL);
    }
    for (const m of sms.sent) expect(scanSecrets(m.text)).toBeNull();
    const logged = JSON.stringify(logs);
    for (const v of [EMAIL, PHONE, "example.test"]) expect(logged).not.toContain(v);
    for (const m of [...email.sent, ...sms.sent]) {
      expect(logged).not.toContain("subject" in m ? m.subject : m.text);
    }
  });
});

describe("failures and retries", () => {
  it("an unavailable provider keeps the row pending, with the backoff of 1, 5, 15 and 60 minutes", async () => {
    queue("welcome");
    email.failNext("unavailable", 3);
    await runNotifier(deps());
    expect(store.rows().find((r) => r.channel === "email")).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    // not due yet (1 minute after creation)
    clock.advanceSeconds(30);
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
    clock.advanceSeconds(60); // 1.5 minutes after creation: attempt 2 fails
    await runNotifier(deps());
    expect(store.rows().find((r) => r.channel === "email")?.attempts).toBe(2);
    clock.advanceSeconds(5 * 60); // 6.5 minutes: attempt 3 fails
    await runNotifier(deps());
    expect(store.rows().find((r) => r.channel === "email")?.attempts).toBe(3);
    clock.advanceSeconds(10 * 60); // 16.5 minutes: attempt 4 succeeds
    await runNotifier(deps());
    expect(email.sent).toHaveLength(1);
    expect(store.rows().find((r) => r.channel === "email")?.status).toBe("sent");
  });

  it("gives up after the last attempt", async () => {
    queue("welcome");
    email.failNext("unavailable", MAX_ATTEMPTS);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      clock.advanceSeconds(3600);
      await runNotifier(deps());
    }
    expect(store.rows().find((r) => r.channel === "email")).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
    });
    clock.advanceSeconds(3600);
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
  });

  it("a rejected message is failed at once and not retried", async () => {
    queue("welcome");
    email.failNext("rejected");
    await runNotifier(deps());
    expect(store.rows().find((r) => r.channel === "email")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    clock.advanceSeconds(3600);
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
  });

  it("a provider that throws with the address in its message does not leak it, and the row is retried", async () => {
    queue("welcome");
    email.failNext("throw");
    await runNotifier(deps());
    expect(JSON.stringify(logs)).not.toContain("example.test");
    expect(store.rows().find((r) => r.channel === "email")).toMatchObject({
      status: "pending",
      attempts: 1,
    });
  });

  it("an SMS outage does not hold back the email or the bell", async () => {
    queue("kyc_approved");
    sms.failNext("unavailable");
    await runNotifier(deps());
    expect(email.sent).toHaveLength(1);
    expect(store.rows().find((r) => r.channel === "in_app")?.status).toBe("sent");
    expect(store.rows().find((r) => r.channel === "sms")?.status).toBe("pending");
  });

  it("a channel pauses for the rest of the run after five failures in a row", async () => {
    for (let i = 0; i < 8; i++) {
      for (const r of planRows({
        customerId: IDS.customer,
        template: "welcome",
        data: {},
        dedupeKey: `k${i}`,
      })) {
        store.add(r, clock.now());
      }
    }
    email.failNext("unavailable", 100);
    await runNotifier(deps());
    const attempted = store.rows().filter((r) => r.channel === "email" && r.attempts > 0).length;
    expect(attempted).toBe(5);
    expect(store.rows().filter((r) => r.channel === "in_app" && r.status === "sent")).toHaveLength(
      8,
    );
  });

  it("two runs that overlap send a row once", async () => {
    queue("kyc_approved");
    await Promise.all([runNotifier(deps()), runNotifier(deps())]);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
  });
});

describe("rows that cannot be sent", () => {
  it("an SMS to a customer without a verified phone is failed with no attempt, and the email still goes", async () => {
    store.setRecipient(IDS.customer, {
      email: EMAIL,
      phone: PHONE,
      phoneVerified: false,
      locale: "bn",
      numerals: "beng",
    });
    queue("kyc_approved");
    await runNotifier(deps());
    expect(sms.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(1);
    expect(store.rows().find((r) => r.channel === "sms")).toMatchObject({
      status: "failed",
      attempts: 0,
    });
    expect(logs.some((l) => l.reason === "no_verified_phone")).toBe(true);
  });

  it("a row of a customer that does not exist is failed with no attempt", async () => {
    store = new InMemoryNotifierStore();
    queue("welcome");
    await runNotifier(deps());
    // (the bell item needs no recipient lookup: the foreign key guarantees the customer in the table)
    expect(store.rows().find((r) => r.channel === "email")).toMatchObject({
      status: "failed",
      attempts: 0,
    });
    expect(email.sent).toHaveLength(0);
  });

  it("a stored payload that looks like a secret is failed, nothing is sent, and the log names the rule only", async () => {
    const [row] = planRows({
      customerId: IDS.customer,
      template: "kyc_rejected",
      data: { submissionId: IDS.submission, reason: "fine" },
      dedupeKey: "bad",
    });
    store.add({ ...row!, payload: { ...row!.payload, reason: "password: hunter2" } }, clock.now());
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
    expect(store.rows()[0]).toMatchObject({ status: "failed", attempts: 0 });
    const logged = JSON.stringify(logs);
    expect(logged).toContain("secret_word");
    expect(logged).not.toContain("hunter2");
  });

  it("a stored payload with an undeclared field is failed, not sent", async () => {
    const [row] = planRows({
      customerId: IDS.customer,
      template: "welcome",
      data: {},
      dedupeKey: "x",
    });
    store.add({ ...row!, payload: { password: "p" } }, clock.now());
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
    expect(store.rows()[0]?.status).toBe("failed");
  });
});

describe("recipients and language", () => {
  it("renders in the customer's locale with the numerals of the customer's market", async () => {
    store.setRecipient(IDS.customer, {
      email: EMAIL,
      phone: PHONE,
      phoneVerified: true,
      locale: "bn",
      numerals: "latn",
    });
    queue("topup_receipt");
    await runNotifier(deps());
    expect(email.sent[0]?.text).toContain("৳1,500.00");
    store.setRecipient(IDS.customer, {
      email: EMAIL,
      phone: PHONE,
      phoneVerified: true,
      locale: "en",
      numerals: "beng",
    });
    store.clear();
    email.reset();
    queue("topup_receipt");
    await runNotifier(deps());
    expect(email.sent[0]?.text).toContain("BDT 1,500.00");
  });

  it("the alert about a changed email goes to the address on the row (the previous one)", async () => {
    queue("security_email_changed", { email: OLD_EMAIL });
    await runNotifier(deps());
    expect(email.sent[0]?.to).toBe(OLD_EMAIL);
    expect(sms.sent[0]?.to).toBe(PHONE);
  });

  it("a visitor row (address only) is sent in Bengali with Bengali numerals", async () => {
    const rows = planRows({
      email: "visitor@example.test",
      template: "topup_receipt",
      data: SAMPLES.topup_receipt.data,
      dedupeKey: "v",
    });
    for (const r of rows) store.add(r, clock.now());
    await runNotifier(deps());
    expect(email.sent[0]?.to).toBe("visitor@example.test");
    expect(email.sent[0]?.text).toContain("৳১,৫০০.০০");
  });

  it("stops early when asked to (the Lambda deadline)", async () => {
    queue("welcome");
    await runNotifier(deps({ shouldStop: () => true }));
    expect(email.sent).toHaveLength(0);
    expect(store.rows().every((r) => r.status === "pending")).toBe(true);
  });
});

describe("the reference of an SMS (WPU-Z3)", () => {
  it("an SMS row is sent with its row id as the reference, so a retry of the row keeps the gateway's message id", async () => {
    queue("kyc_approved");
    await runNotifier(deps());
    const row = store.rows().find((r) => r.channel === "sms");
    expect(row?.status).toBe("sent");
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.reference).toBe(row?.id);
  });

  it("the row id is the reference again when the row is retried after an unavailable gateway", async () => {
    queue("kyc_approved");
    sms.failNext("unavailable");
    await runNotifier(deps());
    const row = store.rows().find((r) => r.channel === "sms");
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    const references: (string | undefined)[] = [];
    const recording = {
      send: (to: string, text: string, reference?: string) => {
        references.push(reference);
        return sms.send(to, text, reference);
      },
    };
    clock.advanceSeconds(3600);
    await runNotifier(deps({ sms: recording }));
    expect(references).toEqual([row?.id]);
    expect(store.rows().find((r) => r.channel === "sms")?.status).toBe("sent");
  });
});

describe("the reason word of a failed SMS (WPU-Z17)", () => {
  const smsRow = () => store.rows().find((r) => r.channel === "sms");
  const answering = (answer: SmsSendResult): SmsProvider => ({
    send: () => Promise.resolve(answer),
  });
  const smsLines = () => logs.filter((line) => line.channel === "sms");

  it("a retried SMS row logs the gateway's reason word", async () => {
    queue("kyc_approved");
    await runNotifier(
      deps({ sms: answering({ ok: false, reason: "unavailable", detail: "ip_not_whitelisted" }) }),
    );
    expect(smsRow()).toMatchObject({ status: "pending", attempts: 1 });
    expect(smsLines()).toEqual([
      {
        event: "notifier_retry",
        row: smsRow()?.id,
        channel: "sms",
        template: "kyc_approved",
        attempts: 1,
        detail: "ip_not_whitelisted",
      },
    ]);
  });

  it("a refused SMS row is failed at once and logs rejected with invalid_number", async () => {
    queue("kyc_approved");
    await runNotifier(
      deps({ sms: answering({ ok: false, reason: "rejected", detail: "invalid_number" }) }),
    );
    expect(smsRow()).toMatchObject({ status: "failed", attempts: 1 });
    expect(smsLines()).toEqual([
      {
        event: "notifier_failed",
        row: smsRow()?.id,
        channel: "sms",
        template: "kyc_approved",
        reason: "rejected",
        attempts: 1,
        detail: "invalid_number",
      },
    ]);
  });

  it("the last attempt of an SMS row logs notifier_failed with the reason word", async () => {
    queue("kyc_approved");
    const gateway = answering({ ok: false, reason: "unavailable", detail: "token" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      clock.advanceSeconds(3600);
      await runNotifier(deps({ sms: gateway }));
    }
    expect(smsRow()).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(smsLines().map((line) => [line.event, line.detail])).toEqual([
      ...Array.from({ length: MAX_ATTEMPTS - 1 }, () => ["notifier_retry", "token"]),
      ["notifier_failed", "token"],
    ]);
  });

  it("a detail that is not one of the fixed words is never logged (R14)", async () => {
    queue("kyc_approved");
    const leaky = {
      ok: false,
      reason: "unavailable",
      detail: `token for ${PHONE}`,
    } as unknown as SmsSendResult;
    await runNotifier(deps({ sms: answering(leaky) }));
    const [line] = smsLines();
    expect(line).toMatchObject({ event: "notifier_retry", channel: "sms" });
    expect(line).not.toHaveProperty("detail");
    expect(JSON.stringify(logs)).not.toContain(PHONE);
  });

  it("a failure without a word (the e-mail, the in-memory gateway) logs no detail", async () => {
    queue("kyc_approved");
    email.failNext("unavailable");
    sms.failNext("rejected");
    await runNotifier(deps());
    const failures = logs.filter(
      (l) => l.event === "notifier_retry" || l.event === "notifier_failed",
    );
    expect(failures.map((l) => l.channel).sort()).toEqual(["email", "sms"]);
    for (const line of failures) expect(line).not.toHaveProperty("detail");
  });
});
