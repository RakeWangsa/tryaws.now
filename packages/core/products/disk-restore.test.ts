import { describe, expect, it } from "vitest";
import { checkDiskSnapshotRestore, type DiskSnapshotRestoreCheck } from "./disk-restore";

const BACKUP = "0190aaaa-0000-7000-8000-0000000000b1";
const SOURCE = "0190aaaa-0000-7000-8000-0000000000d1";
const REGION = "ap-south-1";

const ok = (over: Partial<DiskSnapshotRestoreCheck> = {}): DiskSnapshotRestoreCheck => ({
  requested: BACKUP,
  backup: {
    id: BACKUP,
    family: "backup",
    state: "active",
    parentResourceId: SOURCE,
    region: REGION,
  },
  source: { id: SOURCE, family: "disk", state: "active", parentResourceId: null, region: REGION },
  sourceSizeGb: 100,
  sizeGb: 100,
  region: REGION,
  ...over,
});

describe("checkDiskSnapshotRestore (WPU-B5 item 26)", () => {
  it("accepts the customer's own active snapshot of a disk, in the same Region, not smaller", () => {
    expect(checkDiskSnapshotRestore(ok())).toEqual({ ok: true, value: BACKUP });
    expect(checkDiskSnapshotRestore(ok({ sizeGb: 200 }))).toEqual({ ok: true, value: BACKUP });
  });

  it("the source disk may be destroyed: the final snapshot of a deleted disk restores", () => {
    const r = checkDiskSnapshotRestore(
      ok({
        source: {
          id: SOURCE,
          family: "disk",
          state: "destroyed",
          parentResourceId: null,
          region: REGION,
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("a missing or another customer's snapshot (null) is one answer (R8)", () => {
    expect(checkDiskSnapshotRestore(ok({ backup: null }))).toEqual({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
    expect(checkDiskSnapshotRestore(ok({ source: null }))).toMatchObject({
      ok: false,
      fields: { restoreFromBackupId: "invalid" },
    });
  });

  it("refuses a snapshot that is not a backup, not active, without parent, of another id or of a server", () => {
    const b = ok().backup!;
    for (const backup of [
      { ...b, family: "disk" },
      { ...b, state: "creating" },
      { ...b, parentResourceId: null },
      { ...b, id: SOURCE },
    ]) {
      expect(checkDiskSnapshotRestore(ok({ backup }))).toMatchObject({ ok: false });
    }
    const s = ok().source!;
    expect(
      checkDiskSnapshotRestore(ok({ source: { ...s, family: "linux_instance" } })),
    ).toMatchObject({ ok: false, fields: { restoreFromBackupId: "invalid" } });
    expect(checkDiskSnapshotRestore(ok({ source: { ...s, id: BACKUP } }))).toMatchObject({
      ok: false,
    });
  });

  it("refuses another Region (a snapshot cannot cross a Region)", () => {
    expect(checkDiskSnapshotRestore(ok({ region: "ap-southeast-1" }))).toEqual({
      ok: false,
      error: "validation",
      fields: { region: "invalid" },
    });
  });

  it("refuses a smaller disk and a size that is not known (R16)", () => {
    expect(checkDiskSnapshotRestore(ok({ sizeGb: 50 }))).toEqual({
      ok: false,
      error: "validation",
      fields: { sizeGb: "too_small" },
    });
    expect(checkDiskSnapshotRestore(ok({ sourceSizeGb: Number.NaN }))).toEqual({
      ok: false,
      error: "validation",
      fields: { sizeGb: "unavailable" },
    });
    expect(checkDiskSnapshotRestore(ok({ sourceSizeGb: 0 }))).toMatchObject({ ok: false });
  });
});
