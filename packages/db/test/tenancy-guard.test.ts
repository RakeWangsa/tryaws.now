import { v7 as uuidv7 } from "uuid";
import { expect, it, vi } from "vitest";
import { tenantSnapshot } from "../testing/snapshot";
import type { Queryable } from "./sql";

// tenantSnapshot puts the table names of the map into SQL text. The real map is frozen and holds
// plain names, so the guard is shown against a stand-in map that no database is asked about.
const map = vi.hoisted(() => ({ tables: {} as Record<string, string> }));
vi.mock("../tenancy", () => ({ TENANT_TABLES: map.tables, NON_TENANT_TABLES: [] }));

const standIn = (tables: Record<string, string>) => {
  for (const name of Object.keys(map.tables)) delete map.tables[name];
  Object.assign(map.tables, tables);
};

// A database that answers every statement with one row, and remembers the statements.
function answering(sent: string[]): Queryable {
  return {
    query: (text: string) => {
      sent.push(text);
      return Promise.resolve({ rows: [{ row: "{}" }] });
    },
  } as unknown as Queryable;
}

it.each(["Customers", "customers; drop table customers", 'customers"', "1customers", "", "a b"])(
  "refuses the table name %j before any query",
  async (name) => {
    standIn({ customers: "t.id = $1::uuid", [name]: "true" });
    const sent: string[] = [];
    await expect(tenantSnapshot(answering(sent), uuidv7())).rejects.toThrow(
      /not a plain table name/,
    );
    expect(sent).toEqual([]);
  },
);

it("splices the predicate in parentheses, so that an `or` in it cannot join the rest of the clause", async () => {
  standIn({ customers: "t.id = $1::uuid or true" });
  const sent: string[] = [];
  expect(await tenantSnapshot(answering(sent), uuidv7())).toEqual({ customers: ["{}"] });
  expect(sent).toEqual([
    "select to_jsonb(t)::text as row from customers t where (t.id = $1::uuid or true) order by t.id",
  ]);
});
