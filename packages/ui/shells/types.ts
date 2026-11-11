export type ProductFamily =
  | "cloudServers"
  | "databases"
  | "objectStorage"
  | "loadBalancers"
  | "containers"
  | "cdn"
  | "domains";

export type AppNavId = "dashboard" | ProductFamily | "wallet" | "invoices" | "support" | "settings";

export type AdminNavId =
  | "today"
  | "customers"
  | "payments"
  | "pricing"
  | "catalog"
  | "capacity"
  | "operations"
  | "support"
  | "abuse"
  | "reconciliation"
  | "audit"
  | "admins";

export type AdminRole = "superadmin" | "ops" | "finance" | "support";

export interface NavEntry<Id extends string> {
  readonly id: Id;
  readonly href: string;
  /** Font Awesome class without the style class `fas`, for example `fa-gauge`. */
  readonly icon: string;
  readonly family?: ProductFamily;
}

export interface VisibleNavEntry<Id extends string> {
  entry: NavEntry<Id>;
  soon: boolean;
}
