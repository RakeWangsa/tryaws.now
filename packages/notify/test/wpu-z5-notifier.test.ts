import { supportReplyPayload } from "@tc/db";
import type { LogEvent } from "@tc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryEmailProvider } from "../email/provider";
import { runNotifier, type NotifierDeps } from "../queue/run";
import { InMemoryNotifierStore } from "../queue/store";
import { fixedClock } from "./harness";
import { IDS } from "./samples";

// WPU-Z5: the notifier sends the support_reply rows the admin repository writes (one email row each, the
// payload of supportReplyPayload). The link of a customer's mail names the request: an id is no secret,
// but a random id has all digits in its last group about once in 280, which the check of R14 reads as a
// document number. The link is built by the template from the panel origin and checked fields, so the
// check reads the mail without it; every text of the mail is still checked.

const ORIGIN = "https://my.ticoncloud.test";
const ALL_DIGITS_ID = "0193f7c6-4d5e-5394-8f82-123456789012";

let store: InMemoryNotifierStore;
let email: InMemoryEmailProvider;
let logs: LogEvent[];
const clock = fixedClock();
const deps = (): NotifierDeps => ({
  store,
  email,
  sms: { send: async () => ({ ok: true }) } as unknown as NotifierDeps["sms"],
  clock,
  log: (e) => logs.push(e),
  panelOrigin: ORIGIN,
});

// One row as the admin repository writes it: the template, the payload and the recipient.
const addRow = (
  payload: ReturnType<typeof supportReplyPayload>,
  to: { customerId: string } | { email: string },
) =>
  store.add(
    {
      customerId: "customerId" in to ? to.customerId : null,
      email: "email" in to ? to.email : null,
      channel: "email",
      template: "support_reply",
      payload,
      dedupeKey: `support-reply:${payload.requestId}:${IDS.submission}`,
    },
    clock.now(),
  );

beforeEach(() => {
  clock.set("2026-11-13T10:00:00.000Z");
  store = new InMemoryNotifierStore();
  store.setRecipient(IDS.customer, {
    email: "rahim.uddin@example.test",
    phone: null,
    phoneVerified: false,
    locale: "en",
    numerals: "latn",
  });
  email = new InMemoryEmailProvider();
  logs = [];
});

describe("support_reply through the notifier", () => {
  it("a customer is told about a reply on a request whose id ends in digits only", async () => {
    addRow(supportReplyPayload(ALL_DIGITS_ID, "We refunded it.", "customer"), {
      customerId: IDS.customer,
    });
    await runNotifier(deps());
    expect(store.rows()[0]?.status).toBe("sent");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("rahim.uddin@example.test");
    expect(email.sent[0]?.text).toContain(`${ORIGIN}/en/support/requests/${ALL_DIGITS_ID}`);
    expect(email.sent[0]?.text).not.toContain("We refunded it.");
  });

  it("a visitor gets the reply at the address of the request", async () => {
    addRow(supportReplyPayload(ALL_DIGITS_ID, "We refunded it.", "visitor"), {
      email: "visitor@example.test",
    });
    await runNotifier(deps());
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("visitor@example.test");
    expect(email.sent[0]?.text).toContain("We refunded it.");
    expect(email.sent[0]?.text).toContain(`${ORIGIN}/support`);
  });

  // The text of a reply is still checked: only the link that the template built is set aside.
  it.each([
    ["a phone number", "Call us at 01712345678 today.", "phone_number"],
    ["an address with an id as its name", `Write to ${IDS.request}@example.test`, "email_address"],
    ["a long token around an id", `key sk_${"a".repeat(30)}_${ALL_DIGITS_ID}`, "long_token"],
    ["a document number", "Your NID 1234567890123 is checked.", "long_digits"],
    ["the same id with digits glued to it", `ref ${ALL_DIGITS_ID}0`, "long_digits"],
  ])("a visitor reply that holds %s is refused, nothing is sent", async (_name, body, rule) => {
    addRow(supportReplyPayload(IDS.request, body, "visitor"), { email: "visitor@example.test" });
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
    expect(store.rows()[0]).toMatchObject({ status: "failed", attempts: 0 });
    expect(JSON.stringify(logs)).toContain(rule);
  });

  it("a row written before WPU-Z5 (no audience) is refused, never sent with a guessed text", async () => {
    store.add(
      {
        customerId: IDS.customer,
        email: null,
        channel: "email",
        template: "support_reply",
        payload: { requestId: IDS.request, body: "Hello" },
        dedupeKey: "support-reply:old",
      },
      clock.now(),
    );
    await runNotifier(deps());
    expect(email.sent).toHaveLength(0);
    expect(store.rows()[0]?.status).toBe("failed");
    expect(JSON.stringify(logs)).toContain("bad_payload");
  });
});
