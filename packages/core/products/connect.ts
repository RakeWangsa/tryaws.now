// What a customer needs to connect to a Linux server (WPU-G13) and the name rule of a server
// (WPU-G11). Pure: the login user of an image, the ssh command with the customer's own key name, and
// the display name check that the create form and the rename share. Customer text never becomes an AWS
// name here (R11): the key file name is a sanitized copy used only in text shown back to the customer.

/** The image every Linux server is launched with (the provisioner imports it from here). */
export const DEFAULT_BLUEPRINT_ID = "ubuntu_24_04";

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
  ["wordpress", "bitnami"],
  ["lamp", "bitnami"],
  ["nodejs", "bitnami"],
  ["mean", "bitnami"],
  ["joomla", "bitnami"],
  ["drupal", "bitnami"],
  ["magento", "bitnami"],
  ["gitlab", "bitnami"],
  ["nginx", "bitnami"],
  ["plesk", "ubuntu"],
];

export function loginUserOf(blueprintId: unknown): string | null {
  if (typeof blueprintId !== "string") return null;
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
