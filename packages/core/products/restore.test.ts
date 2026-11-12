import { describe, expect, it } from "vitest";
import { checkRestore, type RestoreCandidate } from "./restore";

const ID = "11111111-1111-4111-8111-111111111111";
const SRC = "22222222-2222-4222-8222-222222222222";
const backup: RestoreCandidate = {
  id: ID,
  family: "backup",
  state: "active",
  parentResourceId: SRC,
  region: "ap-southeast-1",
};
const source: RestoreCandidate = {
  id: SRC,
  family: "linux_instance",
  state: "active",
  parentResourceId: null,
  region: "ap-southeast-1",
};
const base = {
  requested: ID,
  backup,
  source,
  sourceDiskGb: 40,
  planDiskGb: 40,
  planRegion: "ap-southeast-1",
};
const invalid = { ok: false, error: "validation", fields: { restoreFromBackupId: "invalid" } };

describe("checkRestore", () => {
  it("accepts an active backup of a Linux server and a plan that is not smaller", () => {
    expect(checkRestore(base)).toEqual({ ok: true, value: ID });
    expect(checkRestore({ ...base, planDiskGb: 80 })).toEqual({ ok: true, value: ID });
  });

  it("accepts a final backup of a destroyed server (restore to a new server)", () => {
    expect(checkRestore({ ...base, source: { ...source, state: "destroyed" } })).toEqual({
      ok: true,
      value: ID,
    });
  });

  it("answers the same for a missing backup, a missing server and a wrong family", () => {
    expect(checkRestore({ ...base, backup: null })).toEqual(invalid);
    expect(checkRestore({ ...base, source: null })).toEqual(invalid);
    expect(checkRestore({ ...base, backup: { ...backup, family: "disk" } })).toEqual(invalid);
    expect(checkRestore({ ...base, source: { ...source, family: "windows_instance" } })).toEqual(
      invalid,
    );
    expect(checkRestore({ ...base, backup: { ...backup, parentResourceId: null } })).toEqual(
      invalid,
    );
  });

  it("needs an active backup that belongs to that server and the id that was asked", () => {
    for (const state of ["creating", "failed", "destroyed", "suspended"]) {
      expect(checkRestore({ ...base, backup: { ...backup, state } })).toEqual(invalid);
    }
    expect(checkRestore({ ...base, backup: { ...backup, parentResourceId: ID } })).toEqual(invalid);
    expect(checkRestore({ ...base, requested: SRC })).toEqual(invalid);
  });

  it("keeps the Region of the backup", () => {
    expect(checkRestore({ ...base, planRegion: "eu-west-1" })).toMatchObject({
      ok: false,
      fields: { region: "invalid" },
    });
  });

  it("refuses a smaller disk and a disk size that is not known", () => {
    expect(checkRestore({ ...base, planDiskGb: 39 })).toMatchObject({
      ok: false,
      fields: { productId: "too_small" },
    });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkRestore({ ...base, planDiskGb: bad })).toMatchObject({
        ok: false,
        fields: { productId: "unavailable" },
      });
      expect(checkRestore({ ...base, sourceDiskGb: bad })).toMatchObject({
        ok: false,
        fields: { productId: "unavailable" },
      });
    }
  });
});
