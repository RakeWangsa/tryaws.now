import { createManualClock, createMemoryQueue, type LogEvent } from "@tc/core";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { createHandler, handler as realHandler, readConfig } from "./index";

const t = useTempDatabase();

it("runs one sweep, logs the counts and returns the report", async () => {
  const clock = createManualClock(new Date("2000-01-01T01:00:00Z"));
  const logged: LogEvent[] = [];
  const handler = createHandler({
    runTx: (fn) => runTransaction(t.db, fn, { role: "worker_rw" }),
    clock,
    queue: createMemoryQueue({ clock }),
    log: (e) => logged.push(e),
  });
  const report = await handler();
  expect(report).toEqual({
    released: 0,
    resent: 0,
    recovered: 0,
    escalated: 0,
    sent: 0,
    sendFailures: 0,
  });
  expect(logged).toEqual([{ event: "sweep", ...report }]);
});

const QUEUE_URL = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning.fifo";
describe("readConfig", () => {
  it("reads the two variables and does not need TC_ENV", () => {
    expect(readConfig({ PROVISIONING_QUEUE_URL: QUEUE_URL, AWS_REGION: "ap-southeast-1" })).toEqual(
      {
        queueUrl: QUEUE_URL,
        region: "ap-southeast-1",
      },
    );
  });
  it("fails closed, naming the variable and nothing else", () => {
    const ok = { PROVISIONING_QUEUE_URL: QUEUE_URL, AWS_REGION: "ap-southeast-1" };
    for (const name of ["PROVISIONING_QUEUE_URL", "AWS_REGION"]) {
      expect(() => readConfig({ ...ok, [name]: undefined })).toThrow(
        `scheduler: ${name} is missing or invalid`,
      );
    }
    expect(() => readConfig({ ...ok, PROVISIONING_QUEUE_URL: "http://x" })).toThrow(
      "scheduler: PROVISIONING_QUEUE_URL is missing or invalid",
    );
  });
});

describe("handler", () => {
  it("is a function after import, and a call with a missing queue URL rejects with the config error", async () => {
    expect(typeof realHandler).toBe("function");
    const saved = process.env.PROVISIONING_QUEUE_URL;
    delete process.env.PROVISIONING_QUEUE_URL;
    try {
      await expect(realHandler()).rejects.toThrow(
        "scheduler: PROVISIONING_QUEUE_URL is missing or invalid",
      );
    } finally {
      if (saved !== undefined) process.env.PROVISIONING_QUEUE_URL = saved;
    }
  });
});
