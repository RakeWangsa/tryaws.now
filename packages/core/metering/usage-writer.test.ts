import { describe, expect, it } from "vitest";
import { planUsageWrites, type UsageSample } from "./usage-writer";

// WPU-B3 (item 20): the reconciler reads snapshot GB and transfer GB from AWS and writes them into
// usage_records; the metering run only reads them. This is the pure part: which samples are written.

const NOW = new Date("2026-11-13T09:30:00.000Z"); // 15:30 on 2026-11-13 in Dhaka
const R1 = {
  id: "0198f0c0-0000-7000-8000-000000000001",
  awsName: "tc-instance-aaaaaaaaaaaaaaaa",
  state: "active",
};
const R2 = {
  id: "0198f0c0-0000-7000-8000-000000000002",
  awsName: "tc-instance-bbbbbbbbbbbbbbbb",
  state: "stopped",
};
const rows = [R1, R2];
const snap = (over: Partial<UsageSample> = {}): UsageSample => ({
  awsName: R1.awsName,
  metric: "snapshot_gb",
  period: "2026-11-13",
  quantityGb: "40",
  ...over,
});
const xfer = (over: Partial<UsageSample> = {}): UsageSample => ({
  awsName: R1.awsName,
  metric: "transfer_gb",
  period: "2026-11-13T14",
  quantityGb: "0.250000",
  ...over,
});

describe("planUsageWrites", () => {
  it("writes a snapshot sample of today and a transfer sample of an ended hour, by resource id", () => {
    const plan = planUsageWrites([snap(), xfer()], rows, NOW);
    expect(plan.writes).toEqual([
      { resourceId: R1.id, metric: "snapshot_gb", period: "2026-11-13", quantity: "40" },
      { resourceId: R1.id, metric: "transfer_gb", period: "2026-11-13T14", quantity: "0.250000" },
    ]);
    expect(plan.skipped).toEqual({});
  });

  it("accepts the current hour (the newer measurement replaces it) and refuses a later one", () => {
    expect(planUsageWrites([xfer({ period: "2026-11-13T15" })], rows, NOW).writes).toHaveLength(1);
    const later = planUsageWrites([xfer({ period: "2026-11-13T16" })], rows, NOW);
    expect(later.writes).toEqual([]);
    expect(later.skipped).toEqual({ period: 1 });
  });

  it("refuses a snapshot period that is not today and a transfer period that is not an hour", () => {
    const plan = planUsageWrites(
      [
        snap({ period: "2026-11-14" }),
        snap({ period: "2026-11-13T10" }),
        xfer({ period: "2026-11-13" }),
        xfer({ period: "2026-13-45T99" }),
      ],
      rows,
      NOW,
    );
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual({ period: 4 });
  });

  it("refuses a metric that is not one of the two", () => {
    const plan = planUsageWrites([snap({ metric: "cpu_hours" as never })], rows, NOW);
    expect(plan.skipped).toEqual({ metric: 1 });
  });

  it("refuses a quantity that is not plain decimal text (no sign, no exponent, no float, at most 6 decimals)", () => {
    const bad = ["-1", "1e3", "NaN", "", " 1", "1.1234567", "0x10", "1,5", "Infinity", "٣"];
    const plan = planUsageWrites(
      bad.map((q) => snap({ quantityGb: q })),
      rows,
      NOW,
    );
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual({ quantity: bad.length });
  });

  it("refuses a quantity above the sanity cap of one million GB (a unit mistake must not become a charge)", () => {
    const plan = planUsageWrites(
      [snap({ quantityGb: "1000001" }), snap({ quantityGb: "1000000" })],
      rows,
      NOW,
    );
    expect(plan.writes.map((w) => w.quantity)).toEqual(["1000000"]);
    expect(plan.skipped).toEqual({ quantity: 1 });
  });

  it("skips a sample whose name matches no resource of the account, and one of a state that holds no usage", () => {
    const plan = planUsageWrites(
      [
        snap({ awsName: "tc-instance-zzzzzzzzzzzzzzzz" }),
        snap({ awsName: "tc-instance-cccccccccccccccc" }),
      ],
      [
        ...rows,
        {
          id: "0198f0c0-0000-7000-8000-000000000003",
          awsName: "tc-instance-cccccccccccccccc",
          state: "destroyed",
        },
      ],
      NOW,
    );
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual({ unmatched: 1, state: 1 });
  });

  it("refuses two samples for one resource, metric and period: neither is written (R16)", () => {
    const plan = planUsageWrites([snap(), snap({ quantityGb: "41" }), xfer()], rows, NOW);
    expect(plan.writes).toEqual([
      { resourceId: R1.id, metric: "transfer_gb", period: "2026-11-13T14", quantity: "0.250000" },
    ]);
    expect(plan.skipped).toEqual({ duplicate: 2 });
  });

  it("keeps the usage of two resources apart", () => {
    const plan = planUsageWrites(
      [snap(), snap({ awsName: R2.awsName, quantityGb: "10" })],
      rows,
      NOW,
    );
    expect(plan.writes.map((w) => [w.resourceId, w.quantity])).toEqual([
      [R1.id, "40"],
      [R2.id, "10"],
    ]);
  });

  it("gives an empty plan for no samples", () => {
    expect(planUsageWrites([], rows, NOW)).toEqual({ writes: [], skipped: {} });
  });

  it("has a fixed text and no input value in what it returns about a bad sample (R14)", () => {
    const plan = planUsageWrites([snap({ quantityGb: "secret-token-123" })], rows, NOW);
    expect(JSON.stringify(plan)).not.toContain("secret-token");
  });
});
