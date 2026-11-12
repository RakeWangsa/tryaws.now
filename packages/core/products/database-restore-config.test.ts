import type { CatalogProduct } from "@tc/db";
import { describe, expect, it } from "vitest";
import { parseDatabaseConfig, resolveDatabase } from "./database";

const PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (): CatalogProduct => ({
  id: PID,
  family: "database",
  awsId: "micro_2_0",
  platform: null,
  region: "ap-southeast-1",
  specs: {},
  awsPriceUsd: "15.0000",
  billingUnit: "month",
  featureFlag: "database",
  active: true,
});
const raw = { productId: PID, region: "ap-southeast-1", displayName: "Orders DB" };
const BACKUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AT = "2026-11-12T03:15:00.000Z";

describe("database restore fields (WPU-G9)", () => {
  it("keeps a snapshot restore id and puts it on the resolved product and the config", () => {
    const parsed = parseDatabaseConfig({ ...raw, restoreFromBackupId: BACKUP });
    expect(parsed).toEqual({ ok: true, value: { ...raw, restoreFromBackupId: BACKUP } });
    if (!parsed.ok) throw new Error("parse");
    const r = resolveDatabase(parsed.value, row());
    expect(r).toMatchObject({
      ok: true,
      value: { restoreFromBackupId: BACKUP, resourceConfig: { restoreFromBackupId: BACKUP } },
    });
  });
  it("keeps a point-in-time restore: the source database and one instant", () => {
    const parsed = parseDatabaseConfig({ ...raw, restoreSourceId: SOURCE, restoreTime: AT });
    expect(parsed).toEqual({
      ok: true,
      value: { ...raw, restoreSourceId: SOURCE, restoreTime: AT },
    });
    if (!parsed.ok) throw new Error("parse");
    expect(resolveDatabase(parsed.value, row())).toMatchObject({
      ok: true,
      value: { restoreSourceId: SOURCE, restoreTime: AT },
    });
  });
  it("refuses both kinds at once, a bad id, a bad instant and a half point-in-time", () => {
    const bad = [
      { restoreFromBackupId: BACKUP, restoreSourceId: SOURCE, restoreTime: AT },
      { restoreFromBackupId: "nope" },
      { restoreSourceId: SOURCE, restoreTime: "yesterday" },
      { restoreSourceId: SOURCE },
      { restoreTime: AT },
    ];
    for (const extra of bad) expect(parseDatabaseConfig({ ...raw, ...extra }).ok).toBe(false);
  });
  it("a plain config still has no restore field", () => {
    const parsed = parseDatabaseConfig(raw);
    expect(parsed).toEqual({ ok: true, value: raw });
  });
});
