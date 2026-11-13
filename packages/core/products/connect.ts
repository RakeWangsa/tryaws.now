// What a customer needs to connect to a Linux server (WPU-G13) and the name rule of a server
// (WPU-G11). Pure: the login user of an image, the ssh command with the customer's own key name, and
// the display name check that the create form and the rename share. Customer text never becomes an AWS
// name here (R11): the key file name is a sanitized copy used only in text shown back to the customer.

/** The image every Linux server is launched with (the provisioner imports it from here). */
export const DEFAULT_BLUEPRINT_ID = "ubuntu_24_04";

/**
 * WPU-X3. The Bitnami stacks of Lightsail, by id prefix, and whether the Lightsail guide of the stack names
 * `~/bitnami_application_password` as the file of the default application password. One list for the login user and
 * the password file. GitLab logs in as `bitnami` but its file is not named here: nothing is guessed (R16).
 */
export const BITNAMI_STACKS: readonly (readonly [prefix: string, passwordFile: boolean])[] = [
  ["wordpress", true],
  ["lamp", true],
  ["nodejs", true],
  ["mean", true],
  ["joomla", true],
  ["drupal", true],
  ["magento", true],
  ["gitlab", false],
  ["nginx", true],
];

const BITNAMI_PASSWORD_FILE = "~/bitnami_application_password";

// Lightsail documents the default user of each image (connect to your instance with SSH). Prefixes
// are matched in order; an image that is not listed has no guess (the screen then says so).
const LOGIN_USERS: readonly (readonly [string, string])[] = [
  ["ubuntu_", "ubuntu"],
  ["amazon_linux", "ec2-user"],
  ["almalinux_", "ec2-user"],
  ["centos", "ec2-user"],
  ["debian_", "admin"],
  ["freebsd_", "ec2-user"],
  ["opensuse_", "ec2-user"],
  ...BITNAMI_STACKS.map(([prefix]) => [prefix, "bitnami"] as const),
  ["plesk", "ubuntu"],
];

/**
 * WPU-Y1. Lightsail-packaged app images carry the suffix `_ls_<major>_<minor>` (wordpress_ls_1_0, lamp_ls_1_0,
 * node_ls_1_0, nginx_ls_1_0). The Bitnami ids (wordpress, lamp_8_bitnami, nodejs, nginx) do not.
 */
export function isLightsailPackaged(blueprintId: unknown): boolean {
  return (
    typeof blueprintId === "string" && /^[a-z0-9]+(?:_[a-z0-9]+)*_ls_\d+_\d+$/.test(blueprintId)
  );
}

/**
 * WPU-Y1. Where the default application password lives on the instance, from the Lightsail guides: Bitnami images
 * `~/bitnami_application_password`; Lightsail-packaged LAMP and Node.js `~/application_credentials`. The
 * Lightsail-packaged WordPress password is read with the console's "Retrieve default password" command and the
 * Lightsail-packaged Nginx page names no file, so those are null: nothing is guessed (R16).
 */
export function appPasswordFileOf(blueprintId: unknown): string | null {
  if (typeof blueprintId !== "string") return null;
  if (isLightsailPackaged(blueprintId)) {
    return blueprintId.startsWith("lamp_") || blueprintId.startsWith("node_")
      ? "~/application_credentials"
      : null;
  }
  const stack = BITNAMI_STACKS.find(([prefix]) => blueprintId.startsWith(prefix));
  return stack !== undefined && stack[1] ? BITNAMI_PASSWORD_FILE : null;
}

export function loginUserOf(blueprintId: unknown): string | null {
  if (typeof blueprintId !== "string") return null;
  // WPU-Y1: "Lightsail packaged versions of WordPress, Nginx, WordPress Multisite, LAMP, Node.js instances: admin".
  if (isLightsailPackaged(blueprintId)) return "admin";
  // The Bitnami stacks all log in as `bitnami` (VERIFY with GetInstanceAccessDetails in tc-pool-dev).
  if (blueprintId.includes("bitnami")) return "bitnami";
  for (const [prefix, user] of LOGIN_USERS) {
    if (blueprintId.startsWith(prefix)) return user;
  }
  return null;
}

/**
 * WPU-Z19. The login user the provisioner stored from GetInstance `username` ("The user name for connecting to the
 * instance", Lightsail API reference), or null. It wins over `loginUserOf`, whose prefix table cannot tell a Bitnami
 * image (`bitnami`) from a Lightsail-packaged one (`admin`, "Lightsail packaged versions of WordPress, Nginx,
 * WordPress Multisite, LAMP, Node.js instances: admin" in the Lightsail SSH guide) when the id does not say.
 */
export function storedLoginUserOf(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const user = (config as Record<string, unknown>)["loginUser"];
  return typeof user === "string" && USER.test(user) ? user : null;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const USER = /^[a-z][a-z0-9_-]{0,31}$/;

/** The file name the customer saved the private key under: letters, digits, dot, dash, underscore. */
export function keyFileName(keyName: string): string {
  const safe = keyName.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 60);
  return `${safe === "" ? "key" : safe}.pem`;
}

/**
 * `ssh -i <key file> <user>@<address>`. Null when the user is not known or the address is not an IPv4
 * address, so nothing unchecked is ever put in a command the customer pastes into a terminal.
 */
export function sshCommandOf(input: {
  user: string | null;
  host: string;
  keyName: string | null;
}): string | null {
  if (input.user === null || !USER.test(input.user) || !IPV4.test(input.host)) return null;
  const target = `${input.user}@${input.host}`;
  return input.keyName === null || input.keyName === ""
    ? `ssh ${target}`
    : `ssh -i ${keyFileName(input.keyName)} ${target}`;
}

const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

/** The name rule of a server (create and rename): trimmed, up to 60 of letters, digits, space . _ -. */
export function parseServerDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim();
  return DISPLAY_NAME.test(name) ? name : null;
}
