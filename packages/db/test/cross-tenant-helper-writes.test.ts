import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { checkTenantIsolation, type TenantCase } from "../testing/cross-tenant";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

// Writes: the self-write kind, a change of content that adds and removes no row, a read that
// writes, and the owner's own run.
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
const check = (c: TenantCase<S>) => checkTenantIsolation({ pool: t.pool, seed, cases: [c] });
const ownerOf = async (keyId: string): Promise<string | undefined> =>
  (await q("select customer_id from ssh_keys where id = $1", [keyId])).rows[0]?.customer_id;
const addKey = (customerId: string) =>
  q(
    "insert into ssh_keys (id, customer_id, name, public_key, fingerprint) values ($1, $2, 'x', 'ssh-ed25519 B', $3)",
    [uuidv7(), customerId, "SHA256:" + uniqueSuffix()],
  );
const only = (case_: string, check_: string, detail: string) => [
  { case: case_, check: check_, detail },
];

// ---- self-write: the kind of profile.update, sshKeys.add and audit.record --------------------

it("a self-write that adds a row for the owner of the target is a write into the rows of A", async () => {
  const leakySelfWrite: TenantCase<S> = {
    name: "leakySelfWrite",
    kind: "self-write",
    run: async (_c, s) => {
      const owner = await ownerOf(s.keyId); // takes the owner from the target, not from the actor
      if (owner === undefined) return "no_owner";
      await addKey(owner);
      return "created";
    },
  };
  expect(await check(leakySelfWrite)).toEqual(
    only(
      "leakySelfWrite",
      "cross-write",
      "a write of customer B changed rows of customer A in: ssh_keys",
    ),
  );
});

it("a self-write whose answer names a row of A is found", async () => {
  const echoSelfWrite: TenantCase<S> = {
    name: "echoSelfWrite",
    kind: "self-write",
    run: async (c, s) => {
      await addKey(c);
      return { created: true, basedOn: s.keyId };
    },
  };
  expect(await check(echoSelfWrite)).toEqual(
    only("echoSelfWrite", "cross-write", "the answer to customer B names a row of customer A"),
  );
});

it("a self-write that changes nothing proves nothing", async () => {
  const noopSelf: TenantCase<S> = { name: "noopSelf", kind: "self-write", run: async () => "ok" };
  expect(await check(noopSelf)).toEqual(
    only(
      "noopSelf",
      "own-write",
      "the write of customer A on its own rows changed nothing; the case proves nothing",
    ),
  );
});

it("the answer of a self-write may change from call to call: it is not compared with the missing row", async () => {
  let n = 0;
  const volatile: TenantCase<S> = {
    name: "volatile",
    kind: "self-write",
    run: async (c) => {
      await addKey(c);
      return { n: ++n };
    },
  };
  expect(await check(volatile)).toEqual([]);
});

it("a self-write that updates the row of the actor passes (a change of content, not of a row count)", async () => {
  const renames: TenantCase<S> = {
    name: "renames",
    kind: "self-write",
    run: async (c) => {
      await q("update customers set name = 'Rahim' where id = $1", [c]);
      return "ok";
    },
  };
  expect(await check(renames)).toEqual([]);
});

// ---- UPDATE: the rows stay, their content changes -------------------------------------------

it("a leaky UPDATE that always answers ok and adds no row is a write into the rows of A", async () => {
  const leakyUpdateOk: TenantCase<S> = {
    name: "leakyUpdateOk",
    kind: "write",
    run: async (_c, s) => {
      await q("update ssh_keys set name = name || 'x' where id = $1", [s.keyId]);
      return "ok";
    },
  };
  expect(await check(leakyUpdateOk)).toEqual(
    only(
      "leakyUpdateOk",
      "cross-write",
      "a write of customer B changed rows of customer A in: ssh_keys",
    ),
  );
});

it("a leaky UPDATE that tells whether the row existed is found twice: its effect and its answer", async () => {
  const leakyUpdate: TenantCase<S> = {
    name: "leakyUpdate",
    kind: "write",
    run: async (_c, s) =>
      (await q("update ssh_keys set name = name || 'x' where id = $1", [s.keyId])).rowCount
        ? "updated"
        : "not_found",
  };
  expect((await check(leakyUpdate)).map((f) => f.check)).toEqual(["cross-write", "cross-write"]);
});

it("a correct UPDATE passes: B changes nothing, A changes the content of its own row", async () => {
  const scopedUpdate: TenantCase<S> = {
    name: "scopedUpdate",
    kind: "write",
    run: async (c, s) =>
      (
        await q("update ssh_keys set name = name || 'x' where id = $1 and customer_id = $2", [
          s.keyId,
          c,
        ])
      ).rowCount
        ? "updated"
        : "not_found",
  };
  expect(await check(scopedUpdate)).toEqual([]);
});

// ---- the findings of a write -----------------------------------------------------------------

it("a leak into two tables lists both, sorted, joined by a comma and a space", async () => {
  const leakyTwo: TenantCase<S> = {
    name: "leakyTwo",
    kind: "write",
    run: async (_c, s) => {
      await q("delete from ssh_keys where id = $1", [s.keyId]);
      await q(
        "insert into operations (id, resource_id, kind, idempotency_key) values ($1, $2, 'reboot', $3)",
        [uuidv7(), s.resourceId, uniqueSuffix()],
      );
      return "done";
    },
  };
  const findings = await check(leakyTwo);
  expect(findings).toContainEqual({
    case: "leakyTwo",
    check: "cross-write",
    detail: "a write of customer B changed rows of customer A in: operations, ssh_keys",
  });
});

it("the error of the owner's own run is ignored: a write that deletes and then throws is judged by its effect", async () => {
  const deleteThenRedirect: TenantCase<S> = {
    name: "deleteThenRedirect",
    kind: "write",
    run: async (c, s) => {
      await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]);
      throw new Error("NEXT_REDIRECT");
    },
  };
  expect(await check(deleteThenRedirect)).toEqual([]);
});

// ---- a read that writes (D18) ----------------------------------------------------------------

const touchingGet = (touch: string): TenantCase<S> => ({
  name: "touchingGet",
  kind: "read",
  run: async (c, s) => {
    await q(touch, [s.keyId]); // writes the row by id: no scope
    return (
      (await q("select id, name from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
        .rows[0] ?? null
    );
  },
});
const changedByRead = only(
  "touchingGet",
  "cross-read",
  "a read of customer B changed rows of customer A in: ssh_keys",
);

it("a read of B that writes a row of A is found, also when the change is idempotent", async () => {
  // Idempotent: if A's own run came first it would apply this change and B's run would show none.
  expect(await check(touchingGet("update ssh_keys set name = 'seen' where id = $1"))).toEqual(
    changedByRead,
  );
});

it("a read of B that writes a row of A is found when every call changes it again", async () => {
  expect(await check(touchingGet("update ssh_keys set name = name || '+' where id = $1"))).toEqual(
    changedByRead,
  );
});

it("a read that writes only the row of its own actor passes", async () => {
  const marksSeen: TenantCase<S> = {
    name: "marksSeen",
    kind: "read",
    run: async (c, s) => {
      await q("update ssh_keys set name = name || '+' where id = $1 and customer_id = $2", [
        s.keyId,
        c,
      ]);
      return (
        (await q("select id, name from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
          .rows[0] ?? null
      );
    },
  };
  expect(await check(marksSeen)).toEqual([]);
});

// ---- one run at a time, also in a write ------------------------------------------------------

const traced = (kind: "write" | "self-write"): [TenantCase<S>, () => number] => {
  let running = 0;
  let overlap = 0;
  const pause = async () => {
    overlap = Math.max(overlap, ++running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
  };
  const run: TenantCase<S>["run"] =
    kind === "write"
      ? async (c, s) => {
          await pause();
          return (await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
            .rowCount
            ? "deleted"
            : "not_found";
        }
      : async (c) => {
          await pause();
          await addKey(c);
          return "created";
        };
  return [{ name: `traced-${kind}`, kind, run }, () => overlap];
};

it.each(["write", "self-write"] as const)(
  "a %s case is run one run at a time: the runs of B do not overlap",
  async (kind) => {
    const [case_, overlap] = traced(kind);
    expect(await check(case_)).toEqual([]);
    expect(overlap()).toBe(1);
  },
);
