import type { PoolAccountRef } from "@tc/db";
import type { InventoryFailure, InventoryPort, InventoryRead, InventoryResult } from "./inventory";

// A scripted inventory for tests and local runs. Keyed by the platform id of the pool account (not by
// the AWS account id). An account that is not in the script is unreachable, never empty (R16).

export type FakeScript = Record<
  string,
  InventoryRead | { readonly fail: InventoryFailure } | { readonly throws: true }
>;

export function fakeInventory(script: FakeScript): InventoryPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(account: PoolAccountRef): Promise<InventoryResult> {
      calls.push(account.id);
      const entry = script[account.id];
      if (entry === undefined) return { ok: false, reason: "unreachable" };
      if ("throws" in entry) throw new Error("fake inventory: the account could not be read");
      if ("fail" in entry) return { ok: false, reason: entry.fail };
      return { ok: true, value: entry };
    },
  };
}
