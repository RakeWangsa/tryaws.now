import type { AdminNavId, AppNavId, NavEntry, ProductFamily, VisibleNavEntry } from "./types.ts";

export const APP_NAV: readonly NavEntry<AppNavId>[] = [
  { id: "dashboard", href: "/dashboard", icon: "fa-gauge" },
  { id: "cloudServers", href: "/servers", icon: "fa-server", family: "cloudServers" },
  { id: "databases", href: "/databases", icon: "fa-database", family: "databases" },
  { id: "objectStorage", href: "/storage", icon: "fa-box-archive", family: "objectStorage" },
  {
    id: "loadBalancers",
    href: "/load-balancers",
    icon: "fa-scale-balanced",
    family: "loadBalancers",
  },
  { id: "containers", href: "/containers", icon: "fa-cubes", family: "containers" },
  { id: "cdn", href: "/cdn", icon: "fa-globe", family: "cdn" },
  { id: "domains", href: "/domains", icon: "fa-sitemap", family: "domains" },
  { id: "wallet", href: "/wallet", icon: "fa-wallet" },
  { id: "invoices", href: "/invoices", icon: "fa-file-invoice" },
  { id: "support", href: "/support", icon: "fa-life-ring" },
  { id: "settings", href: "/settings/profile", icon: "fa-gear" },
];

export const ADMIN_NAV: readonly NavEntry<AdminNavId>[] = [
  { id: "today", href: "/", icon: "fa-house" },
  { id: "customers", href: "/customers", icon: "fa-users" },
  { id: "payments", href: "/payments", icon: "fa-credit-card" },
  { id: "pricing", href: "/pricing", icon: "fa-tags" },
  { id: "catalog", href: "/catalog", icon: "fa-list" },
  { id: "capacity", href: "/capacity", icon: "fa-gauge-high" },
  { id: "operations", href: "/operations", icon: "fa-list-check" },
  { id: "support", href: "/support", icon: "fa-life-ring" },
  { id: "abuse", href: "/abuse", icon: "fa-triangle-exclamation" },
  { id: "reconciliation", href: "/reconciliation", icon: "fa-scale-unbalanced" },
  { id: "audit", href: "/audit", icon: "fa-clipboard-list" },
  { id: "admins", href: "/admins", icon: "fa-user-shield" },
];

/** The only product pages of 16.8. A family without a page has no public link. */
export const PUBLIC_FAMILY_HREF: Readonly<Partial<Record<ProductFamily, string>>> = {
  cloudServers: "/products/cloud-servers",
  databases: "/products/databases",
  objectStorage: "/products/object-storage",
  domains: "/products/domains",
};

/**
 * Entries of the customer panel for the product families that are on (R12). A family that is
 * neither enabled nor soon is absent; a family that is only soon is shown with `soon: true`.
 */
export function visibleAppNav(
  enabled: readonly ProductFamily[],
  soon: readonly ProductFamily[],
): VisibleNavEntry<AppNavId>[] {
  const result: VisibleNavEntry<AppNavId>[] = [];
  for (const entry of APP_NAV) {
    if (entry.family === undefined || enabled.includes(entry.family)) {
      result.push({ entry, soon: false });
    } else if (soon.includes(entry.family)) {
      result.push({ entry, soon: true });
    }
  }
  return result;
}

/** `null` shows every entry; a list shows the listed ids in the order of `ADMIN_NAV`. */
export function visibleAdminNav(ids: readonly AdminNavId[] | null): VisibleNavEntry<AdminNavId>[] {
  return ADMIN_NAV.filter((entry) => ids === null || ids.includes(entry.id)).map((entry) => ({
    entry,
    soon: false,
  }));
}
