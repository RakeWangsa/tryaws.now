import { describe, expect, it } from "vitest";
import { resumeAfterRenewalAllowed, retentionKeyNeedsSalt } from "./resume-rule";

// WPU-Y3b findings 2 and 7. Pure rules, no database.

const base = (config: Record<string, unknown>, state = "suspended") => ({
  resource: { state, config },
});

describe("a renewal resumes a suspended resource", () => {
  it("when nothing else holds it", () => {
    expect(resumeAfterRenewalAllowed(base({}))).toBe(true);
  });
  it("never while an unpaid usage charge is open (config.unpaidSince): the unpaid job resumes after payment", () => {
    expect(resumeAfterRenewalAllowed(base({ unpaidSince: "2026-11-10T00:00:00.000Z" }))).toBe(
      false,
    );
  });
  it("never when an admin suspended it (section 11)", () => {
    expect(resumeAfterRenewalAllowed(base({ adminSuspended: true }))).toBe(false);
  });
  it("only a suspended resource is resumed", () => {
    expect(resumeAfterRenewalAllowed(base({}, "active"))).toBe(false);
  });
  it("a null mark is no mark", () => {
    expect(resumeAfterRenewalAllowed(base({ unpaidSince: null }))).toBe(true);
  });
});

describe("the key of a retention operation of an unpaid episode", () => {
  it("keeps the plain key while the stored row is live", () => {
    for (const s of ["queued", "running", "waiting", "needs_approval", "needs_attention"]) {
      expect(retentionKeyNeedsSalt(s)).toBe(false);
    }
  });
  it("takes a key with the episode when the stored row is dead (failed) or already done", () => {
    expect(retentionKeyNeedsSalt("failed")).toBe(true);
    expect(retentionKeyNeedsSalt("succeeded")).toBe(true);
  });
});
