import { describe, expect, it } from "vitest";
import { compareInventory, type AwsItem, type DbRow } from "./compare";

const NOW = new Date("2026-11-12T02:00:00Z");
const OLD = new Date("2026-11-11T00:00:00Z");
const POOL = "0190a000-0000-7000-8000-000000000001";

const aws = (over: Partial<AwsItem> = {}): AwsItem => ({
  region: "ap-southeast-1",
  family: "linux_instance",
  awsName: "tc-instance-aaaaaaaaaaaaaaaa",
  state: "active",
  tagged: true,
  ...over,
});
const row = (over: Partial<DbRow> = {}): DbRow => ({
  id: "0190a000-0000-7000-8000-0000000000a1",
  family: "linux_instance",
  region: "ap-southeast-1",
  awsName: "tc-instance-aaaaaaaaaaaaaaaa",
  state: "active",
  createdAt: OLD,
  ...over,
});
const run = (items: AwsItem[], rows: DbRow[]) =>
  compareInventory({ poolAccountId: POOL, aws: items, rows, now: NOW });

describe("compareInventory", () => {
  it("finds nothing when both sides agree", () => {
    expect(run([aws()], [row()])).toEqual([]);
  });

  it("an AWS item tagged for the platform with no row is an orphan", () => {
    const [f] = run([aws()], []);
    expect(f).toMatchObject({ kind: "orphan", reason: "no_row", awsName: aws().awsName });
    expect(f?.resourceId).toBeUndefined();
  });

  it("an AWS item without the platform tag and without a row is not ours: no finding", () => {
    expect(run([aws({ tagged: false })], [])).toEqual([]);
  });

  it("an untagged item (static IP, automatic snapshot) matched by name to a row is fine", () => {
    expect(run([aws({ tagged: false })], [row()])).toEqual([]);
  });

  it("a resource still in AWS that the row calls destroyed or failed is an orphan", () => {
    const destroyed = run([aws()], [row({ state: "destroyed" })]);
    expect(destroyed).toMatchObject([{ kind: "orphan", reason: "row_destroyed" }]);
    expect(destroyed[0]?.resourceId).toBe(row().id);
    expect(run([aws()], [row({ state: "failed" })])).toMatchObject([
      { kind: "orphan", reason: "row_failed" },
    ]);
  });

  it("a live row with no AWS item is missing", () => {
    for (const state of ["active", "stopped", "suspended"]) {
      expect(run([], [row({ state })])).toMatchObject([
        { kind: "missing", reason: "no_aws_resource", resourceId: row().id, dbState: state },
      ]);
    }
  });

  it("rows that are creating, failed or destroyed are not missing", () => {
    for (const state of ["creating", "failed", "destroyed"]) {
      expect(run([], [row({ state })])).toEqual([]);
    }
  });

  it("a row younger than the grace period is not missing yet", () => {
    const young = row({ createdAt: new Date(NOW.getTime() - 5 * 60_000) });
    expect(run([], [young])).toEqual([]);
  });

  it("a row with no AWS name or no region (DNS, backups without a pool) is skipped", () => {
    expect(run([], [row({ awsName: null }), row({ id: "x", region: null })])).toEqual([]);
  });

  it("state drift: active in the database and stopped in AWS, and the reverse", () => {
    expect(run([aws({ state: "stopped" })], [row()])).toMatchObject([
      { kind: "missing", reason: "state_drift", dbState: "active", awsState: "stopped" },
    ]);
    expect(run([aws({ state: "active" })], [row({ state: "stopped" })])).toMatchObject([
      { reason: "state_drift", dbState: "stopped", awsState: "active" },
    ]);
  });

  it("suspended matches a stopped instance; creating and transient or unknown states never drift", () => {
    expect(run([aws({ state: "stopped" })], [row({ state: "suspended" })])).toEqual([]);
    expect(run([aws({ state: "active" })], [row({ state: "creating" })])).toEqual([]);
    expect(run([aws({ state: "pending" })], [row()])).toEqual([]);
    expect(run([aws({ state: "unknown" })], [row()])).toEqual([]);
  });

  it("is deterministic: the same input gives the same findings in the same order", () => {
    const items = [aws({ awsName: "tc-instance-bbbbbbbbbbbbbbbb" }), aws()];
    const a = run(items, []);
    const b = run([...items].reverse(), []);
    expect(a).toEqual(b);
    expect(a.map((f) => f.awsName)).toEqual([
      "tc-instance-aaaaaaaaaaaaaaaa",
      "tc-instance-bbbbbbbbbbbbbbbb",
    ]);
  });

  it("carries the pool account and never a customer id", () => {
    const [f] = run([aws()], []);
    expect(f?.poolAccountId).toBe(POOL);
    expect(Object.keys(f ?? {})).not.toContain("customerId");
  });
});
