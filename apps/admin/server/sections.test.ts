import { ADMIN_NAV } from "@tc/ui";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  SECTION_IDS,
  SECTION_ROLES,
  canOpen,
  isSectionId,
  segmentOf,
  visibleIdsFor,
} from "./sections.ts";

describe("the role matrix of 16.12", () => {
  it("has one row for every entry of the admin navigation, and no other", () => {
    expect([...SECTION_IDS].sort()).toEqual(ADMIN_NAV.map((e) => e.id).sort());
  });

  it("the route segment of each id is its href in the navigation", () => {
    for (const entry of ADMIN_NAV) expect(`/${segmentOf(entry.id)}`).toBe(entry.href);
  });

  it("everyone opens today and the audit log", () => {
    for (const role of ADMIN_ROLES) {
      expect(canOpen(role, "today")).toBe(true);
      expect(canOpen(role, "audit")).toBe(true);
    }
  });

  it("only superadmin opens the admin users", () => {
    expect(ADMIN_ROLES.filter((r) => canOpen(r, "admins"))).toEqual(["superadmin"]);
  });

  it("finance opens payments and pricing, never the capacity or the operations queue", () => {
    expect(canOpen("finance", "payments")).toBe(true);
    expect(canOpen("finance", "pricing")).toBe(true);
    expect(canOpen("finance", "capacity")).toBe(false);
    expect(canOpen("finance", "operations")).toBe(false);
  });

  it("support reads customers and support requests, not pricing or payments", () => {
    expect(visibleIdsFor("support")).toEqual(["today", "customers", "support", "abuse", "audit"]);
  });

  it("superadmin sees every entry", () => {
    expect(visibleIdsFor("superadmin")).toEqual(SECTION_IDS);
  });

  it("an unknown id or role opens nothing", () => {
    expect(canOpen("ops", "nonsense" as never)).toBe(false);
    expect(canOpen("guest" as never, "today")).toBe(false);
    expect(canOpen("ops", "__proto__" as never)).toBe(false);
    expect(isSectionId("constructor")).toBe(false);
    expect(isSectionId("pricing")).toBe(true);
    expect(Object.keys(SECTION_ROLES)).toHaveLength(12);
  });
});
