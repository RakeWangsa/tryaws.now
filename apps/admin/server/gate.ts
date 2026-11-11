import { ipAllowed, parseCidr, parseViewerAddress } from "@tc/auth/admin-ip";

// The second wall behind WAF (6.2, R10): the admin app answers 403 to an address outside the
// allowlist. Pure: the header and the environment are parameters. Fails closed (R16): no list, an
// empty list or one bad entry refuses everyone. Only `next dev` (NODE_ENV=development) may run with no
// list at all, so a developer can open the app on a laptop; a list that is set is enforced there too.
export function adminGate(
  viewerAddress: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env["ADMIN_IP_ALLOWLIST"];
  const entries =
    typeof raw === "string"
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];
  if (entries.length === 0) return env["NODE_ENV"] === "development";
  if (entries.some((e) => parseCidr(e) === null)) return false;
  const ip = parseViewerAddress(viewerAddress);
  return ip !== null && ipAllowed(ip, entries);
}
