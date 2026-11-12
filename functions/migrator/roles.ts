// Creates the database roles with a password (R3: the passwords come from the linked secrets and are
// never logged). The names are the keys of the map, fixed by the caller, never input. Idempotent (R7):
//   - a missing role is created with LOGIN and its password;
//   - a role without LOGIN (migration 0006 creates the five as NOLOGIN) gets LOGIN and the password;
//   - a role that can log in is left alone, so a second run changes nothing. Changing the password
//     of an existing role (rotation) is a decision of its own (JOURNEY.md, Needs decision).
// The statement is built by the server with format(%I, %L), so a name or a password is quoted as data.
// An error is replaced by a fixed one: the driver's message can carry the statement (R14).

export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RoleCounts {
  readonly created: number;
  readonly enabled: number;
  readonly unchanged: number;
}

export async function ensureRoles(
  client: Queryable,
  passwords: Readonly<Record<string, string>>,
): Promise<RoleCounts> {
  const names = Object.keys(passwords);
  if (names.some((name) => passwords[name] === undefined || passwords[name] === "")) {
    throw new Error("migrator: a role password is missing");
  }
  try {
    const { rows } = await client.query(
      "select rolname, rolcanlogin from pg_roles where rolname = any($1)",
      [names],
    );
    const known = new Map(rows.map((r) => [String(r.rolname), r.rolcanlogin === true]));
    let created = 0;
    let enabled = 0;
    let unchanged = 0;
    for (const name of names) {
      const canLogin = known.get(name);
      if (canLogin === true) {
        unchanged += 1;
        continue;
      }
      const verb = canLogin === undefined ? "create" : "alter";
      const { rows: built } = await client.query(
        `select format('${verb} role %I login password %L', $1::text, $2::text) as statement`,
        [name, passwords[name]],
      );
      await client.query(String(built[0]?.statement));
      if (canLogin === undefined) created += 1;
      else enabled += 1;
    }
    return { created, enabled, unchanged };
  } catch {
    throw new Error("migrator: could not prepare the roles");
  }
}
