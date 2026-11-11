import type { Clock } from "@tc/core";
import { OPERATION_KINDS } from "@tc/core";
import { describe, expect, it, vi } from "vitest";
import { orderHooks } from "./order-hooks";

const { compensate } = vi.hoisted(() => ({
  compensate: vi.fn(async () => ({ reversed: true, released: true, replayed: false })),
}));
vi.mock("@tc/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/core")>()),
  compensateFailedCreate: compensate,
}));

const clock: Clock = { now: () => new Date("2026-11-11T10:00:00.000Z") };
const tx = {} as never;

describe("orderHooks", () => {
  it("calls the automatic reversal for a create, with the ids and the code unchanged", async () => {
    compensate.mockClear();
    await orderHooks({ clock }).failed?.(tx, {
      operationId: "op",
      resourceId: "res",
      customerId: "cus",
      kind: "create",
      code: "validation:InvalidInputException",
    });
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(compensate).toHaveBeenCalledWith(
      tx,
      { clock },
      { resourceId: "res", customerId: "cus", code: "validation:InvalidInputException" },
    );
  });

  it("does nothing for any other kind of operation", async () => {
    compensate.mockClear();
    for (const kind of OPERATION_KINDS.filter((k) => k !== "create")) {
      await orderHooks({ clock }).failed?.(tx, {
        operationId: "op",
        resourceId: "res",
        customerId: "cus",
        kind,
        code: "x",
      });
    }
    expect(compensate).not.toHaveBeenCalled();
  });

  it("lets the error of the reversal reach the engine, which rolls the move to failed back", async () => {
    compensate.mockRejectedValueOnce(new Error("orders: the automatic reversal was refused"));
    await expect(
      orderHooks({ clock }).failed?.(tx, {
        operationId: "op",
        resourceId: "res",
        customerId: "cus",
        kind: "create",
        code: "x",
      }),
    ).rejects.toThrow("orders: the automatic reversal was refused");
  });

  it("has a failed slot and nothing else", () => {
    const hooks = orderHooks({ clock });
    expect(typeof hooks.failed).toBe("function");
    expect(hooks.succeeded).toBeUndefined();
    expect(hooks.needsAttention).toBeUndefined();
  });
});
