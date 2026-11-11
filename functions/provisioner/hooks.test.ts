import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { composeHooks } from "./hooks";
import { createFakeCloud, fakeInstanceAdapter } from "./test/fakes";

describe("composeHooks", () => {
  it("runs every hook that has the slot, in the order given, with the same transaction and event", async () => {
    const calls: string[] = [];
    const tx = {} as never;
    const event = {
      operationId: "o",
      resourceId: "r",
      customerId: "c",
      kind: "destroy",
    } as const;
    const hooks = composeHooks(
      {
        succeeded: async (t, e) => {
          calls.push(`a:${t === tx}:${e.operationId}`);
        },
      },
      {},
      {
        succeeded: async () => {
          calls.push("b");
        },
        needsAttention: async (_t, e) => {
          calls.push("n:" + e.code);
        },
      },
    );
    await hooks.succeeded?.(tx, event);
    await hooks.needsAttention?.(tx, {
      operationId: "o",
      resourceId: "r",
      kind: "destroy",
      code: "x",
    });
    expect(calls).toEqual(["a:true:o", "b", "n:x"]);
    expect(hooks.failed).toBeUndefined();
  });

  it("the first hook that throws stops the rest and the error reaches the caller", async () => {
    const ran: string[] = [];
    const hooks = composeHooks(
      {
        succeeded: async () => {
          throw new Error("first failed");
        },
      },
      {
        succeeded: async () => {
          ran.push("second");
        },
      },
    );
    await expect(
      hooks.succeeded?.({} as never, {
        operationId: "o",
        resourceId: "r",
        customerId: "c",
        kind: "create",
      }),
    ).rejects.toThrow("first failed");
    expect(ran).toEqual([]);
  });
});

it("the registry finds a family by its exact name only, prototype names included", () => {
  const registry = createAdapterRegistry([fakeInstanceAdapter(createFakeCloud())]);
  expect(registry.get("linux_instance")?.family).toBe("linux_instance");
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", ""]) {
    expect(registry.get(name), name).toBeUndefined();
  }
  expect(() =>
    createAdapterRegistry([
      fakeInstanceAdapter(createFakeCloud()),
      fakeInstanceAdapter(createFakeCloud()),
    ]),
  ).toThrow("adapter registry: family linux_instance is registered twice");
});
