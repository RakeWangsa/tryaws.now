// What a product family needs in the same market before switching it on makes sense (R12). The admin
// sees it next to the switch; it informs and does not block, because the real guard is the feature flag
// check of the purchase (WP4) and the capacity check. Read from spec 10.3: backups, disks, static IPs and
// load balancers attach to instances; a domain is served by a DNS zone. Needs decision in JOURNEY.md:
// confirm the map before launch.
export const FLAG_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  static_ip: ["linux_instance"],
  backup: ["linux_instance"],
  disk: ["linux_instance"],
  load_balancer: ["linux_instance"],
  domain: ["dns_zone"],
});

export function dependenciesOf(key: string): readonly string[] {
  return Object.hasOwn(FLAG_DEPENDENCIES, key) ? (FLAG_DEPENDENCIES[key] ?? []) : [];
}

/** The dependencies of a family that are off in the market: what the screen warns about. */
export function missingDependencies(
  key: string,
  enabledKeys: ReadonlySet<string>,
): readonly string[] {
  return dependenciesOf(key).filter((dep) => !enabledKeys.has(dep));
}
