import { describe, expect, it } from "vitest";
import {
  DB_BACKUP_RETENTION_DAYS,
  checkDbPointInTime,
  checkDbSnapshotRestore,
  pointInTimeWindow,
} from "./db-restore";

const BACKUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const cand = (over = {}) => ({
  id: BACKUP,
  family: "backup",
  state: "active",
  parentResourceId: SOURCE,
  region: "ap-southeast-1",
  ...over,
});
const src = (over = {}) => ({
  id: SOURCE,
  family: "database",
  state: "active",
  parentResourceId: null,
  region: "ap-southeast-1",
  ...over,
});
const base = {
  requested: BACKUP,
  backup: cand(),
  source: src(),
  sourceDiskGb: 40,
  planDiskGb: 80,
  planRegion: "ap-southeast-1",
};

describe("checkDbSnapshotRestore", () => {
  it("accepts the customer's own active snapshot of a database, a plan not smaller, same Region", () => {
    expect(checkDbSnapshotRestore(base)).toEqual({ ok: true, value: BACKUP });
  });
  it("a destroyed source is fine: the final snapshot of a deleted database restores", () => {
    expect(checkDbSnapshotRestore({ ...base, source: src({ state: "destroyed" }) }).ok).toBe(true);
  });
  it("missing or another customer's row is one answer", () => {
    expect(checkDbSnapshotRestore({ ...base, backup: null })).toMatchObject({
      ok: false,
      fields: { restoreFromBackupId: "invalid" },
    });
  });
  it("refuses a snapshot of a server, one not active, and a backup that is not a backup", () => {
    expect(checkDbSnapshotRestore({ ...base, source: src({ family: "linux_instance" }) }).ok).toBe(
      false,
    );
    expect(checkDbSnapshotRestore({ ...base, backup: cand({ state: "creating" }) }).ok).toBe(false);
    expect(checkDbSnapshotRestore({ ...base, backup: cand({ family: "disk" }) }).ok).toBe(false);
  });
  it("refuses another Region, a smaller plan and an unknown size", () => {
    expect(checkDbSnapshotRestore({ ...base, planRegion: "ap-south-1" })).toMatchObject({
      fields: { region: "invalid" },
    });
    expect(checkDbSnapshotRestore({ ...base, planDiskGb: 20 })).toMatchObject({
      fields: { productId: "too_small" },
    });
    expect(checkDbSnapshotRestore({ ...base, planDiskGb: Number.NaN })).toMatchObject({
      fields: { productId: "unavailable" },
    });
  });
});

describe("point in time", () => {
  const now = new Date("2026-11-12T12:00:00.000Z");
  const run = (over: object) =>
    checkDbPointInTime({
      requested: SOURCE,
      source: src(),
      sourceDiskGb: 40,
      planDiskGb: 80,
      planRegion: "ap-southeast-1",
      at: "2026-11-12T11:00:00.000Z",
      now,
      ...over,
    });
  it("the window is seven days back to five minutes ago", () => {
    expect(DB_BACKUP_RETENTION_DAYS).toBe(7);
    const w = pointInTimeWindow(now);
    expect(w.from.toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-11-12T11:55:00.000Z");
  });
  it("accepts an instant inside, edges included, and refuses outside or unreadable", () => {
    expect(run({}).ok).toBe(true);
    expect(run({ at: "2026-11-05T12:00:00.000Z" }).ok).toBe(true);
    expect(run({ at: "2026-11-12T11:55:00.000Z" }).ok).toBe(true);
    expect(run({ at: "2026-11-12T11:56:00.000Z" })).toMatchObject({
      ok: false,
      fields: { restoreTime: "out_of_range" },
    });
    expect(run({ at: "2026-11-05T11:59:00.000Z" })).toMatchObject({
      ok: false,
      fields: { restoreTime: "out_of_range" },
    });
    expect(run({ at: "garbage" })).toMatchObject({
      ok: false,
      fields: { restoreTime: "invalid" },
    });
  });
  it("needs a live database of the customer in the Region of the plan", () => {
    expect(run({ source: null })).toMatchObject({
      ok: false,
      fields: { restoreSourceId: "invalid" },
    });
    expect(run({ source: src({ state: "destroyed" }) }).ok).toBe(false);
    expect(run({ source: src({ family: "disk" }) }).ok).toBe(false);
    expect(run({ planRegion: "ap-south-1" })).toMatchObject({ fields: { region: "invalid" } });
    expect(run({ planDiskGb: 10 })).toMatchObject({ fields: { productId: "too_small" } });
  });
});
