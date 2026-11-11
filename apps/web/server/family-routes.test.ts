import { describe, expect, it } from "vitest";
import { configurePathOf, detailPathOf } from "./family-routes.ts";

describe("family routes of the order screens", () => {
  it("sends a draft back to the form of its own family, and a server draft to the server form", () => {
    expect(configurePathOf("cdn")).toBe("/cdn/new");
    expect(configurePathOf("database")).toBe("/databases/new");
    expect(configurePathOf("load_balancer")).toBe("/load-balancers/new");
    for (const other of [undefined, "linux_instance", "windows_instance", "", "constructor"]) {
      expect(configurePathOf(other)).toBe("/servers/new");
    }
  });

  it("opens a new resource on the page of its own family; null for a family that has none here", () => {
    expect(detailPathOf("cdn", "abc")).toBe("/cdn/abc");
    expect(detailPathOf("database", "abc")).toBe("/databases/abc");
    expect(detailPathOf("load_balancer", "abc")).toBe("/load-balancers/abc");
    expect(detailPathOf("linux_instance", "abc")).toBeNull();
    expect(detailPathOf(undefined, "abc")).toBeNull();
    expect(detailPathOf("__proto__", "abc")).toBeNull();
  });
});
