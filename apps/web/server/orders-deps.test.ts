import { createMemoryQueue, type OrdersDeps } from "@tc/core";
import { describe, expect, it } from "vitest";
import { assembleOrdersDeps } from "./orders-deps.ts";
import type { WebConfig } from "./config.ts";

const clock = { now: () => new Date("2026-11-12T00:00:00Z") };
const run = (async () => {
  throw new Error("no database in this test");
}) as unknown as OrdersDeps["run"];
const config = (over: Partial<WebConfig>): WebConfig => ({
  stage: "staging",
  appOrigin: "https://staging.example.com",
  epsMode: "sandbox",
  fakes: false,
  ...over,
});
const SECRET = "x".repeat(40);
const envWith = (value: string | undefined): Record<string, string | undefined> => ({
  SST_RESOURCE_OrderDraftSecret: value === undefined ? undefined : JSON.stringify({ value }),
});

describe("assembleOrdersDeps", () => {
  it("is not configured (null, fail closed) without the draft secret outside fake mode", () => {
    expect(assembleOrdersDeps(config({}), envWith(undefined), { run, clock })).toBeNull();
  });

  it("is not configured with a secret under 32 bytes", () => {
    expect(assembleOrdersDeps(config({}), envWith("short"), { run, clock })).toBeNull();
  });

  it("builds the deps from the linked secret and a queue that refuses to send in a real stage", async () => {
    const deps = assembleOrdersDeps(config({}), envWith(SECRET), { run, clock });
    expect(deps).not.toBeNull();
    expect(deps?.secrets).toHaveLength(1);
    expect(Buffer.from(deps?.secrets[0] as Uint8Array).toString("utf8")).toBe(SECRET);
    // The scheduler re-sends a lost message (3.4): a refusing send is the safe default.
    await expect(
      deps?.queue.send({ operationId: "a", resourceId: "b", enqueueSeq: 0 }),
    ).rejects.toThrow();
  });

  it("uses a random secret and a memory queue only when the configuration says fakes", async () => {
    const deps = assembleOrdersDeps(
      config({ stage: "local", appOrigin: "http://localhost:3000", fakes: true }),
      envWith(undefined),
      { run, clock },
    );
    expect(deps?.secrets[0]?.length).toBeGreaterThanOrEqual(32);
    const probe = createMemoryQueue({ clock });
    expect(typeof deps?.queue.send).toBe(typeof probe.send);
    await expect(
      deps?.queue.send({
        operationId: "0190aaaa-0000-7000-8000-000000000001",
        resourceId: "0190aaaa-0000-7000-8000-000000000002",
        enqueueSeq: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("never takes the fake path in production even if asked", () => {
    const deps = assembleOrdersDeps(
      config({ stage: "production", fakes: true }),
      envWith(undefined),
      { run, clock },
    );
    expect(deps).toBeNull();
  });
});
