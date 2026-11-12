import { describe, expect, it } from "vitest";
import { bucketInstancesOf } from "./bucket-view.ts";

// WPU-G9: which of the customer's servers a bucket is open to, read from what the adapter stored.
const r = (id: string, family: string, state: string, name = id) => ({
  id,
  family,
  state: state as never,
  config: { displayName: name },
});

describe("bucketInstancesOf", () => {
  it("lists running and stopped servers only, marks the stored ones, and cuts the name", () => {
    const list = bucketInstancesOf(
      [
        r("a", "linux_instance", "active", "web"),
        r("b", "windows_instance", "stopped", "x".repeat(80)),
        r("c", "linux_instance", "destroyed"),
        r("d", "database", "active"),
        r("e", "linux_instance", "creating"),
      ],
      { accessInstances: ["a", 5, null] },
    );
    expect(list.map((i) => [i.id, i.allowed])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(list[1]!.name).toHaveLength(60);
  });
  it("a config that is not what the adapter writes allows nobody (R16)", () => {
    for (const config of [null, undefined, {}, { accessInstances: "a" }, { accessInstances: {} }]) {
      expect(bucketInstancesOf([r("a", "linux_instance", "active")], config)[0]!.allowed).toBe(
        false,
      );
    }
  });
});
