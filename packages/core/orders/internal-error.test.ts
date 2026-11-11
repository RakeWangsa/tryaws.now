import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import type { LogEvent } from "../operations/index";
import { makeKit, snapshotRows, type Kit } from "../test/orders-kit";
import { makeOrders } from "./place";

// Defect 5 of the review: a database error never leaves placeOrder or createOrderDraft with its SQL
// text or its parameters. The result is `internal` and the log holds a fixed event and the SQLSTATE.
const t = useTempDatabase();

/** Sends the first statement that matches `from` to a table that does not exist: a real PostgreSQL error. */
async function breaking<T>(from: RegExp, to: string, act: () => Promise<T>): Promise<T> {
  const probe = await t.pool.connect();
  const proto = Object.getPrototypeOf(probe) as { query: (...args: unknown[]) => unknown };
  probe.release();
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    if (typeof first === "string" && from.test(first)) {
      args[0] = first.replace(from, to);
    } else if (typeof first === "object" && first !== null && "text" in first) {
      const config = first as { text: string };
      if (from.test(config.text)) {
        args[0] = { ...config, text: config.text.replace(from, to) };
      }
    }
    return original.apply(this, args);
  };
  try {
    return await act();
  } finally {
    proto.query = original;
  }
}

function collector(kit: Kit): { kit: Kit; logs: LogEvent[] } {
  const logs: LogEvent[] = [];
  return { kit: { ...kit, deps: { ...kit.deps, log: (e) => void logs.push(e) } }, logs };
}

/** Nothing of the failed statement, of the customer or of the token in what leaves the function. */
function expectClean(kit: Kit, token: string | null, value: unknown, logs: LogEvent[]): void {
  const text = JSON.stringify([value, logs], (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  for (const forbidden of [
    kit.customerId,
    kit.productId,
    kit.poolAccountId,
    "_nope",
    "insert into",
    "select ",
    "params",
    "Failed query",
    ...(token === null ? [] : [token]),
  ]) {
    expect(text).not.toContain(forbidden);
  }
}

describe("placeOrder: a database error is internal and says nothing", () => {
  it("returns internal, logs a fixed event and the SQLSTATE, and writes nothing, when the resource insert fails", async () => {
    const base = await makeKit(t);
    const { kit, logs } = collector(base);
    const { token } = await kit.draft();
    const before = await snapshotRows(t);
    const result = await breaking(/insert into resources /, "insert into resources_nope ", () =>
      makeOrders(kit.deps).placeOrder(kit.session, {
        token,
        idempotencyKey: "internal-key-" + "a".repeat(16),
      }),
    );
    expect(result).toEqual({ ok: false, error: "internal" });
    expect(logs).toEqual([{ event: "orders.db_error", sqlState: "42P01" }]);
    expectClean(kit, token, result, logs);
    // the rate-limit count is kept (a call is a call); the purchase itself wrote nothing
    const after = await snapshotRows(t);
    expect(after.orders).toEqual(before.orders);
    expect(after.resources).toEqual(before.resources);
    expect(after.ledger_transactions).toEqual(before.ledger_transactions);
    expect(after.wallets).toEqual(before.wallets);
    expect(kit.queue.depth).toBe(0);
  });

  it("returns internal when the rate-limit transaction fails", async () => {
    const base = await makeKit(t);
    const { kit, logs } = collector(base);
    const { token } = await kit.draft();
    const result = await breaking(/insert into rate_limits/, "insert into rate_limits_nope", () =>
      makeOrders(kit.deps).placeOrder(kit.session, {
        token,
        idempotencyKey: "internal-key-" + "b".repeat(16),
      }),
    );
    expect(result).toEqual({ ok: false, error: "internal" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "orders.db_error" });
    expectClean(kit, token, result, logs);
  });

  it("returns internal, with sqlState null, for a failure that is no database error", async () => {
    const base = await makeKit(t);
    const { kit, logs } = collector(base);
    const { token } = await kit.draft();
    const failing = makeOrders({
      ...kit.deps,
      run: () => Promise.reject(new Error("select * from wallets where customer_id = 'secret-id'")),
    });
    const result = await failing.placeOrder(kit.session, {
      token,
      idempotencyKey: "internal-key-" + "c".repeat(16),
    });
    expect(result).toEqual({ ok: false, error: "internal" });
    expect(logs).toEqual([{ event: "orders.db_error", sqlState: null }]);
    expect(JSON.stringify(logs)).not.toContain("secret-id");
  });
});

describe("createOrderDraft: a database error is internal and says nothing", () => {
  it("returns internal and logs only the fixed event and the SQLSTATE", async () => {
    const base = await makeKit(t);
    const { kit, logs } = collector(base);
    const result = await breaking(/from "catalog_products"/, `from "catalog_products_nope"`, () =>
      makeOrders(kit.deps).createOrderDraft(kit.session, kit.input()),
    );
    expect(result).toEqual({ ok: false, error: "internal" });
    expect(logs).toEqual([{ event: "orders.db_error", sqlState: "42P01" }]);
    expectClean(kit, null, result, logs);
  });
});
