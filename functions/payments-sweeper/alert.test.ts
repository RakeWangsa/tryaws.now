import type { LogEvent } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createLogAlert } from "./alert";

const base = {
  kind: "payment_review" as const,
  paymentId: "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
  reason: "amount_mismatch",
};

describe("createLogAlert", () => {
  it("writes one payment_review line with the listed keys", async () => {
    const logs: LogEvent[] = [];
    await createLogAlert((e) => logs.push(e)).raise({
      ...base,
      expectedMinor: 150000n,
      gotMinor: 149999n,
    });
    expect(logs).toEqual([
      {
        event: "payment_review",
        severity: "alert",
        paymentId: base.paymentId,
        reason: "amount_mismatch",
        expectedMinor: "150000",
        gotMinor: "149999",
      },
    ]);
    expect(() => JSON.stringify(logs[0])).not.toThrow();
  });

  it("keeps a null got amount null", async () => {
    const logs: LogEvent[] = [];
    await createLogAlert((e) => logs.push(e)).raise({ ...base, expectedMinor: 1n, gotMinor: null });
    expect(logs[0]!.gotMinor).toBeNull();
  });

  it("round-trips amounts above the safe integer exactly (R4)", async () => {
    const logs: LogEvent[] = [];
    await createLogAlert((e) => logs.push(e)).raise({
      ...base,
      expectedMinor: 9007199254740993n,
      gotMinor: 9007199254740995n,
    });
    expect(logs[0]!.expectedMinor).toBe("9007199254740993");
    expect(logs[0]!.gotMinor).toBe("9007199254740995");
  });

  it("swallows a throwing logger", async () => {
    const alert = createLogAlert(() => {
      throw new Error("log down");
    });
    await expect(
      alert.raise({ ...base, expectedMinor: 1n, gotMinor: 1n }),
    ).resolves.toBeUndefined();
  });
});
