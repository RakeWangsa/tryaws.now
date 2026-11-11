import type { ProductFamily } from "@tc/ui";

// The twelve product flags of section 10.3 and the seven families of the customer navigation
// (16.7). A family is shown when at least one of its flags is on in the customer's market (R12).
// `static_ip`, `backup` and `disk` are parts of a server, not a navigation entry of their own.
const FAMILY_OF_FLAG: Readonly<Record<string, ProductFamily | undefined>> = {
  linux_instance: "cloudServers",
  windows_instance: "cloudServers",
  database: "databases",
  bucket: "objectStorage",
  load_balancer: "loadBalancers",
  container_service: "containers",
  cdn: "cdn",
  dns_zone: "domains",
  domain: "domains",
};

const ORDER: readonly ProductFamily[] = [
  "cloudServers",
  "databases",
  "objectStorage",
  "loadBalancers",
  "containers",
  "cdn",
  "domains",
];

export function enabledFamilies(
  flags: readonly { key: string; enabled: boolean }[],
): ProductFamily[] {
  const on = new Set<ProductFamily>();
  for (const flag of flags) {
    const family = FAMILY_OF_FLAG[flag.key];
    if (flag.enabled && family !== undefined) on.add(family);
  }
  return ORDER.filter((family) => on.has(family));
}
