import type { CustomerSession } from "@tc/auth";
import {
  DEFAULT_BLUEPRINT_ID,
  currentFirewallRules,
  isBlueprintId,
  loginUserOf,
  optionOf,
  rulesOpenSshToWorld,
} from "@tc/core";
import type { FirewallRule } from "@tc/core";
import { customerRepos, readFeatureFlag, readImage, withTx } from "@tc/db";
import { loadStaticIpHourMinor, staticIpFeeOf } from "./static-ip-fee.ts";
import type { StaticIpFee } from "./static-ip-fee.ts";

// What the header buttons and the Networking tab of /servers/[id] need (WPU-G2), read through the
// repositories of the session's customer only (R8). A database error is thrown, never answered with
// defaults (R16). Nothing here returns an AWS account id, an ARN, a generated AWS name or an error
// text of AWS (U6, R11): the resource config is read field by field.

const FAMILIES = ["linux_instance", "windows_instance"];
const IN_FLIGHT = ["queued", "running", "waiting", "needs_approval"];
// The kinds that the actions of server-actions.ts do not run side by side.
const CONFLICTING = [
  "reboot",
  "stop",
  "start",
  "set_ports",
  "attach_static_ip",
  "detach_static_ip",
];

export interface ServerManage {
  /** R12: the flag of the server's family. With it off the buttons and forms are not shown. */
  flagOn: boolean;
  /** One id per render of the page: the idempotency key of the forms on it (R7). */
  requestId: string;
  state: string;
  /** The saved or default rules; null when the saved list cannot be read (then nothing is edited). */
  rules: FirewallRule[] | null;
  sshOpenToWorld: boolean;
  staticIpAttached: boolean;
  /** WPU-M1: the hourly price of an unattached IP (paisa as text) and whether the charge is running. */
  staticIpFee: StaticIpFee;
  /** The default user of the image, null when the image is not known (always null for Windows). */
  loginUser: string | null;
  /** A power, firewall or static IP operation is on its way: the forms wait for it. */
  busy: boolean;
}

export async function loadServerManage(
  session: CustomerSession,
  id: string,
  requestId: string,
): Promise<ServerManage | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || !FAMILIES.includes(resource.family)) return null;
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("server-manage: no customer row");
    const flagOn = (await readFeatureFlag(tx, resource.family, profile.market)) === true;
    const operations = flagOn ? await repos.operations.listForResource(id) : [];
    const config =
      typeof resource.config === "object" && resource.config !== null
        ? (resource.config as Record<string, unknown>)
        : {};
    const rules = currentFirewallRules(resource.config, resource.family);
    // WPU-G13: the login user of the image this server runs (the one ordered, else the default one):
    // the synced row says it, the table of names covers a row that is gone.
    const imageId =
      resource.family !== "linux_instance"
        ? null
        : isBlueprintId(config["blueprintId"])
          ? config["blueprintId"]
          : DEFAULT_BLUEPRINT_ID;
    const imageRow =
      imageId === null || resource.region === null
        ? null
        : await readImage(tx, resource.region, imageId);
    const loginUser =
      imageId === null
        ? null
        : ((imageRow === null ? null : optionOf(imageRow)?.loginUser) ?? loginUserOf(imageId));
    return {
      flagOn,
      requestId,
      state: resource.state,
      rules,
      sshOpenToWorld: rules !== null && rulesOpenSshToWorld(rules),
      staticIpAttached: config["staticIpAttached"] !== false,
      staticIpFee: staticIpFeeOf(resource.config, await loadStaticIpHourMinor(tx, profile.market)),
      loginUser,
      busy: operations.some((o) => IN_FLIGHT.includes(o.state) && CONFLICTING.includes(o.kind)),
    };
  });
}
