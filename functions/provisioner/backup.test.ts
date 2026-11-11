import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { backupAdapter, diskAdapter } from "./backup";
import { linuxInstanceAdapter } from "./linux";

describe("registration of the WP5-T1 and WP5-T2 families", () => {
  it("the registry holds the instance, backup and disk families, each once", () => {
    const registry = createAdapterRegistry([
      linuxInstanceAdapter(),
      backupAdapter(),
      diskAdapter(),
    ]);
    expect(registry.get("linux_instance")).toBeDefined();
    expect(registry.get("backup")?.family).toBe("backup");
    expect(registry.get("disk")?.family).toBe("disk");
    expect(registry.get("constructor")).toBeUndefined();
  });

  it("the instance adapter keeps its config parser and accepts the backup actions through the wrapper", () => {
    const adapter = linuxInstanceAdapter();
    expect(() => adapter.parseConfig({})).toThrow();
    expect(typeof adapter.aws.finalSnapshot).toBe("function");
  });
});
