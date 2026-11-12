import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_NAV, APP_NAV, PUBLIC_FAMILY_HREF, visibleAdminNav, visibleAppNav } from "./nav.ts";
import type { AdminNavId, AppNavId, ProductFamily } from "./types.ts";

const faCss = readFileSync(
  fileURLToPath(new URL("../theme/assets/fonts/fontawesome/css/all.min.css", import.meta.url)),
  "utf8",
);

const FAMILIES: readonly ProductFamily[] = [
  "cloudServers",
  "databases",
  "objectStorage",
  "loadBalancers",
  "containers",
  "cdn",
  "domains",
];

describe("APP_NAV", () => {
  it("ids are unique and in the order of 16.7", () => {
    const ids = APP_NAV.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "dashboard",
      "cloudServers",
      "databases",
      "objectStorage",
      "loadBalancers",
      "containers",
      "cdn",
      "domains",
      "wallet",
      "invoices",
      "support",
      "settings",
    ]);
  });

  it("hrefs start with / and match 16.10", () => {
    for (const entry of APP_NAV) expect(entry.href.startsWith("/")).toBe(true);
    expect(APP_NAV.map((e) => [e.id, e.href])).toEqual([
      ["dashboard", "/dashboard"],
      ["cloudServers", "/servers"],
      ["databases", "/databases"],
      ["objectStorage", "/storage"],
      ["loadBalancers", "/load-balancers"],
      ["containers", "/containers"],
      ["cdn", "/cdn"],
      ["domains", "/domains"],
      ["wallet", "/wallet"],
      ["invoices", "/invoices"],
      ["support", "/support/new"],
      ["settings", "/settings/profile"],
    ]);
  });

  it("every icon class exists in the vendored Font Awesome", () => {
    expect(faCss.length).toBeGreaterThan(1000);
    for (const entry of [...APP_NAV, ...ADMIN_NAV]) {
      expect(entry.icon.startsWith("fa-")).toBe(true);
      expect(faCss.includes(`.${entry.icon}`), `${entry.id}: ${entry.icon}`).toBe(true);
    }
  });

  it("family entries carry their own id as family", () => {
    for (const entry of APP_NAV) {
      if ((FAMILIES as readonly string[]).includes(entry.id)) {
        expect(entry.family).toBe(entry.id);
      } else {
        expect(entry.family).toBeUndefined();
      }
    }
    expect(APP_NAV.filter((e) => e.family !== undefined)).toHaveLength(7);
  });
});

describe("ADMIN_NAV", () => {
  it("ids and hrefs match 16.12", () => {
    expect(ADMIN_NAV.map((e) => [e.id, e.href, e.icon])).toEqual([
      ["today", "/", "fa-house"],
      ["customers", "/customers", "fa-users"],
      ["payments", "/payments", "fa-credit-card"],
      ["pricing", "/pricing", "fa-tags"],
      ["catalog", "/catalog", "fa-list"],
      ["capacity", "/capacity", "fa-gauge-high"],
      ["operations", "/operations", "fa-list-check"],
      ["support", "/support", "fa-life-ring"],
      ["abuse", "/abuse", "fa-triangle-exclamation"],
      ["reconciliation", "/reconciliation", "fa-scale-unbalanced"],
      ["audit", "/audit", "fa-clipboard-list"],
      ["admins", "/admins", "fa-user-shield"],
    ]);
  });
});

describe("visibleAppNav", () => {
  it("hides a family that is neither enabled nor soon", () => {
    const ids = visibleAppNav(["cloudServers"], []).map((v) => v.entry.id);
    expect(ids).toContain("cloudServers");
    for (const hidden of [
      "databases",
      "objectStorage",
      "loadBalancers",
      "containers",
      "cdn",
      "domains",
    ]) {
      expect(ids).not.toContain(hidden as AppNavId);
    }
  });

  it("marks a soon family", () => {
    const view = visibleAppNav(["cloudServers"], ["databases"]);
    expect(view.find((v) => v.entry.id === "databases")).toMatchObject({ soon: true });
    expect(view.find((v) => v.entry.id === "cloudServers")).toMatchObject({ soon: false });
  });

  it("an enabled family wins over the same family in soon", () => {
    const view = visibleAppNav(["databases"], ["databases"]);
    expect(view.find((v) => v.entry.id === "databases")).toMatchObject({ soon: false });
  });

  it("entries without family are always visible", () => {
    const view = visibleAppNav([], []);
    expect(view.map((v) => v.entry.id)).toEqual([
      "dashboard",
      "wallet",
      "invoices",
      "support",
      "settings",
    ]);
    for (const v of view) expect(v.soon).toBe(false);
  });

  it("keeps the order of APP_NAV", () => {
    const view = visibleAppNav(FAMILIES, []);
    expect(view.map((v) => v.entry.id)).toEqual(APP_NAV.map((e) => e.id));
  });
});

describe("visibleAdminNav", () => {
  it("returns all twelve for null", () => {
    const view = visibleAdminNav(null);
    expect(view).toHaveLength(12);
    expect(view.map((v) => v.entry.id)).toEqual(ADMIN_NAV.map((e) => e.id));
    for (const v of view) expect(v.soon).toBe(false);
  });

  it("keeps ADMIN_NAV order whatever the order of the list", () => {
    const ids: AdminNavId[] = ["audit", "today", "payments"];
    expect(visibleAdminNav(ids).map((v) => v.entry.id)).toEqual(["today", "payments", "audit"]);
  });

  it("returns nothing for an empty list", () => {
    expect(visibleAdminNav([])).toEqual([]);
  });
});

describe("PUBLIC_FAMILY_HREF", () => {
  it("has exactly the four product pages of 16.8", () => {
    expect(PUBLIC_FAMILY_HREF).toEqual({
      cloudServers: "/products/cloud-servers",
      databases: "/products/databases",
      objectStorage: "/products/object-storage",
      domains: "/products/domains",
    });
  });
});
