import type { AccountRef, AwsAccess, CatalogSource } from "@tc/aws";
import type { LogEvent } from "@tc/core";
import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { CatalogSyncConfig } from "./config";
import { buildCatalogSyncDeps } from "./deps";

const config: CatalogSyncConfig = {
  poolAccountId: "111122223333",
  dnsAccountId: null,
  dnsExternalId: null,
  regions: ["ap-southeast-1"],
  syncTlds: false,
};

/** A transaction double: a select answers the next queued rows, a write answers like a fresh insert. */
function fakeTx(selects: unknown[][]): Tx {
  const queue = [...selects];
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => resolve(queue.shift() ?? []);
  return {
    select: () => chain,
    execute: async () => ({ rows: [{ inserted: true }] }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  } as unknown as Tx;
}

const NANO = {
  bundleId: "nano_3_0",
  name: "Nano",
  cpuCount: 2,
  ramSizeInGb: 0.5,
  diskSizeInGb: 20,
  transferPerMonthInGb: 1024,
  priceUsd: "5",
  publicIpv4AddressCount: 1,
  supportedPlatforms: ["LINUX_UNIX"],
  isActive: true,
  instanceType: "nano",
  power: 300,
};

describe("buildCatalogSyncDeps", () => {
  it("runs one transaction per store call and none during a source call", async () => {
    const events: string[] = [];
    const selects: unknown[][] = [
      [{ awsAccountId: "111122223333", externalId: "ext-1" }], // poolAccount
      [], // existing
    ];
    const source: CatalogSource = {
      async instanceBundles() {
        events.push("source");
        return [NANO];
      },
      async instanceBlueprints() {
        return [];
      },
      async distributionBundles() {
        return [];
      },
      async databaseBlueprints() {
        return [];
      },
      async tldPrices() {
        events.push("tlds");
        return [];
      },
    };
    const logs: LogEvent[] = [];
    const { handler } = buildCatalogSyncDeps({
      syncImages: false,
      syncExtras: false,
      config,
      access: {} as AwsAccess<"catalog-sync">,
      runTx: async (fn) => {
        events.push("tx-begin");
        try {
          return await fn(fakeTx(selects.splice(0, 1)));
        } finally {
          events.push("tx-end");
        }
      },
      clock: { now: () => new Date("2030-01-01T00:00:00Z") },
      log: (e) => logs.push(e),
      source,
    });
    const report = await handler();
    expect(events).toEqual([
      "tx-begin",
      "tx-end", // poolAccount
      "source",
      "tx-begin",
      "tx-end", // existing
      "tx-begin",
      "tx-end", // apply
    ]);
    expect(report.regions[0]).toMatchObject({ ok: true, mapped: 1, inserted: 1 });
  });

  it("reads no process.env and no global clock: the builder receives both", () => {
    const realNow = Date.now;
    const savedEnv = process.env;
    let touched = false;
    Date.now = () => {
      touched = true;
      return realNow();
    };
    try {
      Object.defineProperty(process, "env", {
        value: new Proxy(savedEnv, {
          get() {
            touched = true;
            return undefined;
          },
        }),
        configurable: true,
      });
      buildCatalogSyncDeps({
        config,
        access: {} as AwsAccess<"catalog-sync">,
        runTx: async (fn) => fn(fakeTx([])),
        clock: { now: () => new Date(0) },
        log: () => {},
        source: {
          instanceBundles: async () => [],
          instanceBlueprints: async () => [],
          distributionBundles: async () => [],
          databaseBlueprints: async () => [],
          tldPrices: async () => [],
        },
        syncImages: false,
        syncExtras: false,
      });
    } finally {
      Object.defineProperty(process, "env", { value: savedEnv, configurable: true });
      Date.now = realNow;
    }
    expect(touched).toBe(false);
  });

  it("turns the DNS settings into the DNS account", async () => {
    let seen: AccountRef | undefined;
    const { handler } = buildCatalogSyncDeps({
      syncImages: false,
      syncExtras: false,
      config: {
        ...config,
        dnsAccountId: "444455556666",
        dnsExternalId: "dns-ext-1",
        syncTlds: true,
      },
      access: {} as AwsAccess<"catalog-sync">,
      runTx: async (fn) =>
        fn(fakeTx([[{ awsAccountId: "111122223333", externalId: "ext-1" }], [], []])),
      clock: { now: () => new Date(0) },
      log: () => {},
      source: {
        instanceBundles: async () => [NANO],
        instanceBlueprints: async () => [],
        distributionBundles: async () => [],
        databaseBlueprints: async () => [],
        tldPrices: async (a) => {
          seen = a;
          return [];
        },
      },
    });
    await handler();
    expect(seen).toEqual({ awsAccountId: "444455556666", externalId: "dns-ext-1" });
  });
});
