import { createMemoryQueue, type OrdersDeps } from "@tc/core";
import { describe, expect, it } from "vitest";
import { assembleOrdersDeps } from "./orders-deps.ts";
import type { WebConfig } from "./config.ts";
import { envLinks } from "@tc/db/links";
import { linkedSecrets } from "./secrets.ts";

const clock = { now: () => new Date("2026-11-12T00:00:00Z") };
const run = (async () => {
  throw new Error("no database in this test");
}) as unknown as OrdersDeps["run"];
const config = (over: Partial<WebConfig>): WebConfig => ({
  stage: "staging",
  appOrigin: "https://staging.example.com",
  epsMode: "sandbox",
  fakes: false,
  fake: { eps: false, idp: false, sms: false },
  ...over,
});
const SECRET = "x".repeat(40);
const envWith = (value: string | undefined): Record<string, string | undefined> => ({
  SST_RESOURCE_OrderDraftSecret: value === undefined ? undefined : JSON.stringify({ value }),
});

// The secret comes from the SST_RESOURCE_<Name> variables of the environment object (envLinks); the
// run-time path through the SST SDK is secrets-sst.test.ts (WPU-Z15).
const assemble = (
  cfg: WebConfig,
  env: Record<string, string | undefined>,
  ports: Parameters<typeof assembleOrdersDeps>[2],
) => assembleOrdersDeps(cfg, env, ports, linkedSecrets(envLinks(env)));

describe("assembleOrdersDeps", () => {
  it("is not configured (null, fail closed) without the draft secret outside fake mode", () => {
    expect(assemble(config({}), envWith(undefined), { run, clock })).toBeNull();
  });

  it("is not configured with a secret under 32 bytes", () => {
    expect(assemble(config({}), envWith("short"), { run, clock })).toBeNull();
  });

  it("builds the deps from the linked secret and a queue that refuses to send in a real stage", async () => {
    const deps = assemble(config({}), envWith(SECRET), { run, clock });
    expect(deps).not.toBeNull();
    expect(deps?.secrets).toHaveLength(1);
    expect(Buffer.from(deps?.secrets[0] as Uint8Array).toString("utf8")).toBe(SECRET);
    // The scheduler re-sends a lost message (3.4): a refusing send is the safe default.
    await expect(
      deps?.queue.send({ operationId: "a", resourceId: "b", enqueueSeq: 0 }),
    ).rejects.toThrow();
  });

  it("keeps the refusing fallback queue when the queue URL is malformed (G2: sweep fallback)", async () => {
    const deps = assemble(
      config({}),
      { ...envWith(SECRET), PROVISIONING_QUEUE_URL: "https://evil.example.com/x" },
      { run, clock },
    );
    await expect(
      deps?.queue.send({ operationId: "a", resourceId: "b", enqueueSeq: 0 }),
    ).rejects.toThrow("no queue client");
  });

  it("uses the SQS port when a FIFO queue URL is configured, without building a client at assembly", () => {
    const deps = assemble(
      config({}),
      {
        ...envWith(SECRET),
        PROVISIONING_QUEUE_URL:
          "https://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning.fifo",
      },
      { run, clock },
    );
    expect(deps).not.toBeNull();
    expect(deps?.queue.send).toBeTypeOf("function");
  });

  it("uses a random secret and a memory queue only when the configuration says fakes", async () => {
    const deps = assemble(
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
    const deps = assemble(config({ stage: "production", fakes: true }), envWith(undefined), {
      run,
      clock,
    });
    expect(deps).toBeNull();
  });
});
