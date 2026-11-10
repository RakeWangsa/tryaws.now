import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { insertRow, type Queryable } from "./sql";

export function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
}

// Inserts a market once; a second call with the same code does nothing. Returns the code.
export async function ensureMarket(q: Queryable, code = "BD"): Promise<string> {
  await q.query(
    `insert into markets
       (id, code, currency, gateway, locales, numerals, topup_min_minor, topup_max_minor)
     values ($1, $2, 'BDT', 'eps', '{bn,en}', 'beng', 10000, 5000000)
     on conflict (code) do nothing`,
    [uuidv7(), code],
  );
  return code;
}

// Inserts an admin user with a cognito_sub that no other call shares. Returns the id.
export async function newAdmin(q: Queryable, role = "finance"): Promise<string> {
  return insertRow(q, "admin_users", { cognito_sub: "admin-" + uniqueSuffix(), role });
}

// Inserts a customer with a cognito_sub and an email that no other call shares. Returns the id.
export async function newCustomer(
  q: Queryable,
  over: Record<string, unknown> = {},
): Promise<string> {
  const market = await ensureMarket(q);
  const suffix = uniqueSuffix();
  return insertRow(q, "customers", {
    cognito_sub: "sub-" + suffix,
    email: suffix + "@example.test",
    market,
    ...over,
  });
}
