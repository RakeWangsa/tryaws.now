import { expect, it } from "vitest";
import { columnsOf, type Queryable } from "./sql";

export const EXPECTED_COLUMNS: Record<string, string[]> = {};

export function expectedFor(table: string): string[] {
  const own = EXPECTED_COLUMNS[table];
  if (own === undefined) throw new Error(`no expected columns for ${table}`);
  return [...own, "created_at timestamptz NOT NULL", "id uuid NOT NULL"].sort();
}

export function columnTests(getPool: () => Queryable, tables: readonly string[]): void {
  it.each(tables)("%s has exactly the columns of the plan", async (table) => {
    expect(await columnsOf(getPool(), table)).toEqual(expectedFor(table));
  });
}
