import { expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();

it("every table has a uuid id without a database default as its only primary key and a created_at with a default", async () => {
  const { rows } = await t.pool.query(`
    select t.table_name,
      (select string_agg(k.column_name, ',') from information_schema.table_constraints c
         join information_schema.key_column_usage k on k.constraint_name = c.constraint_name and k.table_name = c.table_name
          and k.table_schema = c.table_schema and k.constraint_schema = c.constraint_schema
        where c.table_schema = 'public' and c.table_name = t.table_name and c.constraint_type = 'PRIMARY KEY') as pk,
      (select udt_name from information_schema.columns where table_schema = 'public' and table_name = t.table_name and column_name = 'id') as id_type,
      (select column_default from information_schema.columns where table_schema = 'public' and table_name = t.table_name and column_name = 'id') as id_default,
      (select is_nullable || ' ' || udt_name || ' ' || coalesce(column_default, '') from information_schema.columns
        where table_schema = 'public' and table_name = t.table_name and column_name = 'created_at') as created
    from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'`);
  for (const r of rows)
    expect(r, r.table_name).toEqual({
      table_name: r.table_name,
      pk: "id",
      id_type: "uuid",
      id_default: null,
      created: "NO timestamptz now()",
    });
});

it("R4: every _minor column is bigint and no column is a float or money type", async () => {
  const { rows } = await t.pool.query(`
    select table_name || '.' || column_name as col, udt_name from information_schema.columns
    where table_schema = 'public' and (column_name like '%\\_minor' or udt_name in ('float4', 'float8', 'money'))`);
  // markets 2, wallets, ledger_entries, wallet_adjustments, payments, orders, invoices 1 each
  expect(rows.length).toBeGreaterThanOrEqual(8);
  for (const r of rows) expect(r, r.col).toEqual({ col: r.col, udt_name: "int8" });
});

it("R8: every customer_id column leads an index", async () => {
  const { rows } = await t.pool.query(`
    select c.relname as table_name from pg_attribute a join pg_class c on c.oid = a.attrelid
    where a.attname = 'customer_id' and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not exists (select 1 from pg_index i where i.indrelid = c.oid and i.indkey[0] = a.attnum)`);
  expect(rows.map((r) => r.table_name)).toEqual([]);
});
