import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { TENANT_TABLES } from "../tenancy";
import { checkTenantIsolation, type TenantCase } from "../testing/cross-tenant";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

// The order of the runs and of the snapshots of customer A, for each kind of case. The order is part
// of the verdict: B goes first, so that an idempotent change by A's own run cannot hide a change by B.
const t = useTempDatabase();
type S = { keyId: string; resourceId: string };
const seed = async (pool: typeof t.pool, c: string): Promise<S> => ({
  keyId: await insertRow(pool, "ssh_keys", {
    customer_id: c,
    name: "k",
    public_key: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:" + uniqueSuffix(),
  }),
  resourceId: await newResource(pool, c),
});
const q = (text: string, values: unknown[]) => t.pool.query(text, values);

// A snapshot sends one query per tenant table, in name order: the query on the first table marks it.
const FIRST_TABLE = Object.keys(TENANT_TABLES).sort()[0] as string;

const sequenceOf = async (kind: TenantCase<S>["kind"]): Promise<string[]> => {
  const sequence: string[] = [];
  const traced = new Proxy(t.pool, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "query") {
        return (...args: unknown[]) => {
          const text = args[0];
          if (typeof text === "string" && text.includes("to_jsonb") && text.includes(FIRST_TABLE)) {
            sequence.push("snapshot");
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const seeded: string[] = [];
  let realKey = "";
  const body: Record<TenantCase<S>["kind"], (c: string, s: S) => Promise<unknown>> = {
    read: async (c, s) =>
      (await q("select id from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
        .rows[0] ?? null,
    write: async (c, s) =>
      (await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c])).rowCount
        ? "deleted"
        : "not_found",
    "self-write": async (c) => {
      await q(
        "insert into ssh_keys (id, customer_id, name, public_key, fingerprint) values ($1, $2, 'x', 'ssh-ed25519 B', $3)",
        [uuidv7(), c, "SHA256:" + uniqueSuffix()],
      );
      return "created";
    },
  };
  const findings = await checkTenantIsolation({
    pool: traced,
    seed: async (pool, c) => {
      const s = await seed(pool, c);
      seeded.push(c);
      if (seeded.length === 1) realKey = s.keyId;
      return s;
    },
    cases: [
      {
        name: "traced",
        kind,
        run: async (c, s) => {
          sequence.push(`${c === seeded[0] ? "A" : "B"}:${s.keyId === realKey ? "real" : "ghost"}`);
          return body[kind](c, s);
        },
      },
    ],
  });
  expect(findings).toEqual([]);
  return sequence;
};

it("a read takes a snapshot of A around B's run on A's rows, then runs B on the ghost, then A on its rows and on the ghost", async () => {
  expect(await sequenceOf("read")).toEqual([
    "snapshot",
    "B:real",
    "snapshot",
    "B:ghost",
    "A:real",
    "A:ghost",
  ]);
});

it("a write takes a snapshot, runs B, takes a snapshot, runs B on the ghost, takes a snapshot, runs A, takes a snapshot", async () => {
  expect(await sequenceOf("write")).toEqual([
    "snapshot",
    "B:real",
    "snapshot",
    "B:ghost",
    "snapshot",
    "A:real",
    "snapshot",
  ]);
});

it("a self-write never runs on the ghost", async () => {
  expect(await sequenceOf("self-write")).toEqual([
    "snapshot",
    "B:real",
    "snapshot",
    "snapshot",
    "A:real",
    "snapshot",
  ]);
});
