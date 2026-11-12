import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import { createDatabaseDraftCore, dhakaLocalToIso } from "./databases-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

// WPU-G9: the draft of a database started from a snapshot or from a point in time. The core hands the
// order code the checked fields of the chosen mode and nothing else; the order code reads the rows
// through the scoped repository (R8) and checks the window against its clock.
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SNAP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(),
});
function orderDeps() {
  const seen: unknown[] = [];
  const deps: OrderActionDeps = {
    authenticate: async () => session(),
    rateLimit: async () => ({ allowed: true }),
    orders: {
      createOrderDraft: async (_s: unknown, request: unknown) => {
        seen.push(request);
        return { ok: true, value: { token: "signed" } } as never;
      },
      placeOrder: async () => {
        throw new Error("not used");
      },
    },
  };
  return { deps, seen };
}
const base = { productId: PRODUCT, region: "ap-southeast-1", displayName: "Restored DB" };

describe("dhakaLocalToIso", () => {
  it("reads a local Dhaka time (UTC+6) and answers an ISO instant", () => {
    expect(dhakaLocalToIso("2026-11-10T15:00")).toBe("2026-11-10T09:00:00.000Z");
    expect(dhakaLocalToIso("2026-11-10T03:30")).toBe("2026-11-09T21:30:00.000Z");
  });
  it("refuses anything that is not that shape", () => {
    for (const bad of [
      "",
      "tomorrow",
      "2026-13-40T99:99",
      "2026-11-10",
      "2026-11-10T15:00Z; x",
      5,
      null,
    ]) {
      expect(dhakaLocalToIso(bad)).toBeNull();
    }
  });
});

describe("createDatabaseDraftCore, restore modes", () => {
  it("snapshot mode passes the snapshot id and no point in time", async () => {
    const { deps, seen } = orderDeps();
    const r = await createDatabaseDraftCore(
      deps,
      {
        ...base,
        restoreFromBackupId: SNAP,
        restoreSourceId: SOURCE,
        restoreTime: "2026-11-10T15:00",
      },
      "snapshot",
    );
    expect(r).toEqual({ ok: true, token: "signed" });
    expect(seen).toEqual([{ family: "database", config: { ...base, restoreFromBackupId: SNAP } }]);
  });
  it("point-in-time mode passes the source and the instant as ISO, and no snapshot", async () => {
    const { deps, seen } = orderDeps();
    await createDatabaseDraftCore(
      deps,
      {
        ...base,
        restoreSourceId: SOURCE,
        restoreTime: "2026-11-10T15:00",
        restoreFromBackupId: SNAP,
      },
      "point_in_time",
    );
    expect(seen).toEqual([
      {
        family: "database",
        config: { ...base, restoreSourceId: SOURCE, restoreTime: "2026-11-10T09:00:00.000Z" },
      },
    ]);
  });
  it("refuses a missing id or an unreadable time before the order code is reached", async () => {
    const a = orderDeps();
    expect(await createDatabaseDraftCore(a.deps, base, "snapshot")).toMatchObject({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
    const b = orderDeps();
    expect(
      await createDatabaseDraftCore(
        b.deps,
        { ...base, restoreSourceId: SOURCE, restoreTime: "soon" },
        "point_in_time",
      ),
    ).toMatchObject({ ok: false, error: "validation", fields: { restoreTime: "invalid" } });
    expect(a.seen).toEqual([]);
    expect(b.seen).toEqual([]);
  });
  it("a plain draft ignores restore fields (the mode is an argument of the code, not of the form)", async () => {
    const { deps, seen } = orderDeps();
    await createDatabaseDraftCore(deps, {
      ...base,
      restoreFromBackupId: SNAP,
      restoreTime: "2026-11-10T15:00",
    });
    expect(seen).toEqual([{ family: "database", config: base }]);
  });
});
