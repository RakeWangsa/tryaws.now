import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { pollingRepo } from "../repositories/system/polling";
import { runTransaction } from "../tx";
import { newCustomer, newPoolAccount, newResource } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-B3 (item 21): the two lists of the scheduled polls, as worker_rw, against the real schema.

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const NOW = new Date("2026-11-13T09:30:00.000Z");
const STALE_BEFORE = new Date("2026-11-12T09:30:00.000Z");
let customerId = "";
let pool = "";
const ids: Record<string, string> = {};

const make = (family: string, state: string, config: unknown) =>
  newResource(t.pool, customerId, {
    family,
    state,
    pool_account_id: pool,
    region: "ap-southeast-1",
    config: JSON.stringify(config),
  });

beforeAll(async () => {
  customerId = await newCustomer(t.pool);
  pool = await newPoolAccount(t.pool);
  ids.dbNever = await make("database", "active", {});
  ids.dbOld = await make("database", "active", {
    parameters: { readAt: "2026-11-10T00:00:00.000Z" },
  });
  ids.dbFresh = await make("database", "active", {
    parameters: { readAt: NOW.toISOString() },
  });
  ids.dbStopped = await make("database", "stopped", {});
  ids.dbJunk = await make("database", "active", { parameters: { readAt: 12 } });
  ids.lbPending = await make("load_balancer", "active", {
    certificate: { status: "PENDING_VALIDATION", attached: false },
  });
  ids.cdnIssued = await make("cdn", "active", {
    certificate: { status: "ISSUED", attached: false },
  });
  ids.csIssuedNoFlag = await make("container_service", "active", {
    certificate: { status: "ISSUED" },
  });
  ids.lbDone = await make("load_balancer", "active", {
    certificate: { status: "ISSUED", attached: true },
  });
  ids.lbNone = await make("load_balancer", "active", {});
  ids.lbPendingStopped = await make("load_balancer", "stopped", {
    certificate: { status: "PENDING_VALIDATION" },
  });
  ids.instance = await make("linux_instance", "active", {
    certificate: { status: "PENDING_VALIDATION" },
  });
});

describe("pollingRepo.databasesToRead", () => {
  it("lists active databases never read, read before the limit, or with a readAt it cannot read", async () => {
    const found = await worker((tx) => pollingRepo(tx).databasesToRead(STALE_BEFORE, null, 100));
    expect(new Set(found)).toEqual(new Set([ids.dbNever, ids.dbOld, ids.dbJunk]));
  });

  it("leaves out a database read after the limit, a database that is not active and other families", async () => {
    const found = await worker((tx) => pollingRepo(tx).databasesToRead(STALE_BEFORE, null, 100));
    for (const id of [ids.dbFresh, ids.dbStopped, ids.lbPending, ids.instance]) {
      expect(found).not.toContain(id);
    }
  });

  it("pages by id, in id order, without repeating", async () => {
    const all = await worker((tx) => pollingRepo(tx).databasesToRead(STALE_BEFORE, null, 100));
    expect([...all].sort()).toEqual(all);
    const first = await worker((tx) => pollingRepo(tx).databasesToRead(STALE_BEFORE, null, 2));
    const rest = await worker((tx) =>
      pollingRepo(tx).databasesToRead(STALE_BEFORE, first[first.length - 1] ?? null, 2),
    );
    expect([...first, ...rest]).toEqual(all);
  });

  it("refuses a bad id, a bad limit and a bad date with fixed texts", async () => {
    await expect(
      worker((tx) => pollingRepo(tx).databasesToRead(STALE_BEFORE, "nope", 10)),
    ).rejects.toThrow("polling: afterId is not a UUID");
    await expect(
      worker((tx) => pollingRepo(tx).databasesToRead(STALE_BEFORE, null, 0)),
    ).rejects.toThrow("polling: limit must be from 1 to 1000");
    await expect(
      worker((tx) => pollingRepo(tx).databasesToRead(new Date("x"), null, 10)),
    ).rejects.toThrow("polling: staleBefore");
  });
});

describe("pollingRepo.certificatesToRefresh", () => {
  it("lists active load balancers, CDNs and container services whose certificate waits for validation or attach", async () => {
    const found = await worker((tx) => pollingRepo(tx).certificatesToRefresh(null, 100));
    expect(new Set(found)).toEqual(new Set([ids.lbPending, ids.cdnIssued, ids.csIssuedNoFlag]));
  });

  it("leaves out an attached certificate, a resource without one, one that is not active and other families", async () => {
    const found = await worker((tx) => pollingRepo(tx).certificatesToRefresh(null, 100));
    for (const id of [ids.lbDone, ids.lbNone, ids.lbPendingStopped, ids.instance, ids.dbNever]) {
      expect(found).not.toContain(id);
    }
  });

  it("pages by id", async () => {
    const all = await worker((tx) => pollingRepo(tx).certificatesToRefresh(null, 100));
    const first = await worker((tx) => pollingRepo(tx).certificatesToRefresh(null, 1));
    const rest = await worker((tx) => pollingRepo(tx).certificatesToRefresh(first[0] ?? null, 100));
    expect([...first, ...rest]).toEqual(all);
  });
});
