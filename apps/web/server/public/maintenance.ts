// The maintenance page sits behind one switch: the environment variable TC_MAINTENANCE. Only the
// exact text "on" turns it on; anything else (unset, "off", "1", "true") leaves the site as it is, so
// a typo cannot take the site down. The locale layout reads it and, when it is on, shows the
// maintenance page instead of the page of the request (no database read, no sign-in check).

export function maintenanceOn(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["TC_MAINTENANCE"] === "on";
}
