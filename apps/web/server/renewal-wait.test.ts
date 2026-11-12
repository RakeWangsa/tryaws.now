import { describe, expect, it } from "vitest";
import { renewalWaitOf } from "./renewal-wait.ts";

describe("renewalWaitOf", () => {
  it("names a stopped resource of a running subscription", () => {
    expect(renewalWaitOf("active", "stopped", false)).toBe("stopped");
    expect(renewalWaitOf("grace", "stopped", false)).toBe("stopped");
  });
  it("names a resource that is being created or has a change in flight", () => {
    expect(renewalWaitOf("active", "creating", false)).toBe("busy");
    expect(renewalWaitOf("active", "active", true)).toBe("busy");
  });
  it("says nothing for an idle active resource, other states and other subscriptions", () => {
    expect(renewalWaitOf("active", "active", false)).toBeNull();
    expect(renewalWaitOf("active", "failed", false)).toBeNull();
    expect(renewalWaitOf("retained", "stopped", false)).toBeNull();
    expect(renewalWaitOf("ended", "active", true)).toBeNull();
    expect(renewalWaitOf(null, "stopped", true)).toBeNull();
  });
});
