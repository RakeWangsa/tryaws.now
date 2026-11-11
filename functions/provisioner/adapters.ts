import type { ProductAdapter } from "@tc/aws";

export interface AdapterRegistry {
  get(family: string): ProductAdapter<unknown> | undefined;
}

// Backed by a Map: resources.family is text that web_rw writes, so "__proto__" or "constructor"
// must find nothing. The production registry is empty until WP4-T5; every operation then ends in
// needs_attention with no_adapter (R16).
export function createAdapterRegistry(
  adapters: readonly ProductAdapter<unknown>[],
): AdapterRegistry {
  const byFamily = new Map<string, ProductAdapter<unknown>>();
  for (const adapter of adapters) {
    if (byFamily.has(adapter.family)) {
      throw new Error(`adapter registry: family ${adapter.family} is registered twice`);
    }
    byFamily.set(adapter.family, adapter);
  }
  return { get: (family) => byFamily.get(family) };
}
