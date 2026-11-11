import { createManualClock, createMemoryQueue, type LogEvent } from "@tc/core";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { expect, it } from "vitest";
import { createHandler } from "./index";

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
