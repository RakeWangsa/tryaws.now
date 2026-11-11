import { createManualClock, createMemoryQueue, type LogEvent } from "@tc/core";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { createHandler, handler as realHandler, readConfig } from "./index";

const t = useTempDatabase();

it("runs the sweep, the lifecycle pass and the rate-limit purge, and logs the counts", async () => {
  const clock = createManualClock(new Date("2026-11-11T01:00:00Z"));
  await t.pool.query(
    "insert into rate_limits (id, scope_key, window_start, count) values (gen_random_uuid(), 'ip:a', '2026-11-01T00:00:00Z', 1), (gen_random_uuid(), 'ip:b', '2026-11-11T00:30:00Z', 1)",
  );
  const logged: LogEvent[] = [];
  const handler = createHandler({
    runTx: (fn) => runTransaction(t.db, fn, { role: "worker_rw" }),
    clock,
    queue: createMemoryQueue({ clock }),
    log: (e) => logged.push(e),
  });
  const report = await handler();
  expect(report.sweep).toEqual({
    released: 0,
    resent: 0,
    recovered: 0,
    escalated: 0,
    sent: 0,
    sendFailures: 0,
  });
  expect(report.lifecycle).toMatchObject({ examined: 0, failed: 0 });
  expect(report.metering).toMatchObject({ charged: 0, failed: 0, priceMissing: true });
  expect(report.rateLimitsPurged).toBe(1);
  expect(logged.map((e) => e.event)).toEqual(["sweep", "lifecycle_run", "metering_run", "rate_limits_purged"]);
  // The second run purges nothing more.
  expect((await handler()).rateLimitsPurged).toBe(0);
});

it("a failing job does not stop the others; the run then rejects (R16)", async () => {
  const clock = createManualClock(new Date("2026-11-11T01:00:00Z"));
  const logged: LogEvent[] = [];
  let calls = 0;
  const handler = createHandler({
    runTx: (fn) => {
      calls += 1;
      // The sweep transaction fails; the lifecycle and the purge go on.
      if (calls === 1) return Promise.reject(new Error("boom with a secret value"));
      return runTransaction(t.db, fn, { role: "worker_rw" });
    },
    clock,
    queue: createMemoryQueue({ clock }),
    log: (e) => logged.push(e),
  });
  await expect(handler()).rejects.toThrow("scheduler: sweep failed");
  expect(logged.map((e) => e.event)).toEqual([
    "scheduler_job_failed",
    "lifecycle_run",
    "metering_run",
    "rate_limits_purged",
  ]);
  expect(JSON.stringify(logged)).not.toContain("secret");
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
