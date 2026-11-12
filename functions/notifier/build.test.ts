import type { LogEvent } from "@tc/core";
import { InMemoryNotifierStore, planRows, type SesRequest, type SesTransport } from "@tc/notify";
import { expect, it } from "vitest";
import { buildNotifierHandler } from "./build";

const CUSTOMER = "0193f7c2-5b8a-7c3e-9a1b-1234567890ab";
const ADDRESS = "rahim.uddin@example.test";
const config = {
  panelOrigin: "https://my.ticoncloud.test",
  sesFrom: "TiCON Cloud <no-reply@ticoncloud.test>",
};

const DATA: Record<string, Record<string, string>> = {
  welcome: {},
  kyc_approved: { submissionId: "0193f7c2-5b8a-7c3e-9a1b-1234567890cd" },
};

function seeded(templates: string[] = ["welcome"]) {
  const store = new InMemoryNotifierStore();
  store.setRecipient(CUSTOMER, {
    email: ADDRESS,
    phone: "+8801712345678",
    phoneVerified: true,
    locale: "bn",
    numerals: "beng",
  });
  for (const template of templates) {
    for (const r of planRows({
      customerId: CUSTOMER,
      template: template as "welcome",
      data: DATA[template] ?? {},
      dedupeKey: template,
    })) {
      store.add(r, new Date("2026-11-11T09:00:00.000Z"));
    }
  }
  return store;
}

const fakeTransport = () => {
  const requests: SesRequest[] = [];
  const transport: SesTransport = {
    send: (request) => {
      requests.push(request);
      return Promise.resolve({ messageId: `ses-${requests.length}` });
    },
  };
  return { transport, requests };
};

const build = (store: InMemoryNotifierStore, transport: SesTransport | null) => {
  const logs: LogEvent[] = [];
  const handler = buildNotifierHandler({
    config,
    store,
    sesTransport: transport,
    clock: { now: () => new Date("2026-11-11T10:00:00.000Z") },
    log: (e) => logs.push(e),
  });
  return { handler, logs };
};

it("sends the pending e-mail through the SES transport port with the configured sender", async () => {
  const { transport, requests } = fakeTransport();
  const store = seeded();
  const { handler } = build(store, transport);
  const report = await handler({});
  expect(report.sent).toBeGreaterThanOrEqual(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.from).toBe(config.sesFrom);
  expect(requests[0]!.to).toBe(ADDRESS);
  expect(requests[0]!.charset).toBe("UTF-8");
  expect(store.rows().find((r) => r.channel === "email")!.status).toBe("sent");
});

it("a second run sends nothing again", async () => {
  const { transport, requests } = fakeTransport();
  const store = seeded();
  const { handler } = build(store, transport);
  await handler({});
  await handler({});
  expect(requests).toHaveLength(1);
});

it("fails closed without an SES transport: the run throws and no row is touched", async () => {
  const store = seeded();
  const before = JSON.stringify(store.rows());
  const { handler, logs } = build(store, null);
  await expect(handler({})).rejects.toThrow("notifier: email is not configured");
  expect(JSON.stringify(store.rows())).toBe(before);
  expect(logs).toContainEqual({ event: "notifier_not_configured", channel: "email" });
});

it("leaves SMS rows pending while no gateway is configured, and still sends the e-mail", async () => {
  // kyc_approved is queued for e-mail, SMS and the bell
  const { transport, requests } = fakeTransport();
  const store = seeded(["kyc_approved"]);
  expect(store.rows().filter((r) => r.channel === "sms").length).toBeGreaterThan(0);
  const { handler } = build(store, transport);
  await handler({});
  for (const row of store.rows().filter((r) => r.channel === "sms")) {
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  }
  expect(requests).toHaveLength(1);
});

it("logs no address and no text", async () => {
  const { transport } = fakeTransport();
  const { handler, logs } = build(seeded(), transport);
  await handler({});
  const text = JSON.stringify(logs);
  expect(text).not.toContain(ADDRESS);
  expect(text).not.toContain("example.test");
});

it("a transport that throws is retried later and its error text is dropped", async () => {
  const store = seeded();
  const transport: SesTransport = {
    send: () => Promise.reject(Object.assign(new Error(`failed for ${ADDRESS}`), { name: "X" })),
  };
  const { handler, logs } = build(store, transport);
  const report = await handler({});
  // the bell item needs no provider; the e-mail is retried later
  expect(report.retry).toBe(1);
  expect(store.rows().find((r) => r.channel === "email")!.status).toBe("pending");
  expect(JSON.stringify(logs)).not.toContain(ADDRESS);
});
