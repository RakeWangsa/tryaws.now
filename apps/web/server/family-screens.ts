import type { ProductFamily } from "@tc/ui";

// Where the order flow sends the customer for a product family that has its own screens: back to the
// form the draft came from, to the page of the new resource, and which entry of the navigation is lit.
// A family that is not here is a server and goes to /servers (the default of the flow). A new family
// adds one row; the pages do not change. `ns` is the message namespace whose `order.open` is the text
// of the button.
export interface FamilyScreen {
  readonly base: string;
  readonly nav: ProductFamily;
  readonly ns: "Cdn" | "Storage" | "Containers" | "Databases" | "LoadBalancers" | "Domains" | "Dns";
}

export const FAMILY_SCREENS: Readonly<Record<string, FamilyScreen | undefined>> = {
  cdn: { base: "/cdn", nav: "cdn", ns: "Cdn" },
  domain: { base: "/domains", nav: "domains", ns: "Domains" },
  dns_zone: { base: "/dns", nav: "domains", ns: "Dns" },
  bucket: { base: "/storage", nav: "objectStorage", ns: "Storage" },
  database: { base: "/databases", nav: "databases", ns: "Databases" },
  load_balancer: { base: "/load-balancers", nav: "loadBalancers", ns: "LoadBalancers" },
  container_service: { base: "/containers", nav: "containers", ns: "Containers" },
};

/** The key of the noun of a product family in `Orders.status.noun` and `.title` (WPU-R1). */
export type OrderNoun =
  | "server"
  | "disk"
  | "bucket"
  | "database"
  | "loadBalancer"
  | "containerService"
  | "cdn"
  | "dnsZone"
  | "domain"
  | "staticIp"
  | "backup";

const NOUN_OF_FAMILY: Readonly<Record<string, OrderNoun | undefined>> = {
  linux_instance: "server",
  windows_instance: "server",
  disk: "disk",
  bucket: "bucket",
  database: "database",
  load_balancer: "loadBalancer",
  container_service: "containerService",
  cdn: "cdn",
  dns_zone: "dnsZone",
  domain: "domain",
  static_ip: "staticIp",
  backup: "backup",
};

/** What the customer bought, by its own noun. No family or an unknown one is a server (the default of the flow). */
export function orderNoun(family: string | undefined): OrderNoun {
  return (
    (family !== undefined && Object.hasOwn(NOUN_OF_FAMILY, family)
      ? NOUN_OF_FAMILY[family]
      : undefined) ?? "server"
  );
}

export function familyScreen(family: string | undefined): FamilyScreen | undefined {
  return family !== undefined && Object.hasOwn(FAMILY_SCREENS, family)
    ? FAMILY_SCREENS[family]
    : undefined;
}
