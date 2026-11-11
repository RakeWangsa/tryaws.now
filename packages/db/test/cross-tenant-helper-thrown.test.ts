import { expect, it } from "vitest";
import { checkTenantIsolation, type TenantCase } from "../testing/cross-tenant";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

// A thrown error is an answer, and so is a returned one: B must get the same for a row of A as for a
// row that does not exist. These tests cover what the helper records of an answer that is an error.
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

// The owner finds the key; anyone else gets whatever `answer` makes of "the row is missing" (true,
// for the request about a row that does not exist) or "the row is somebody else's" (false).
const answering = (
  answer: (missing: boolean, keyId: string) => unknown,
  how: "throw" | "return",
): TenantCase<S> => ({
  name: "answering",
  kind: "read",
  run: async (c, s) => {
    const owner = await ownerOf(s.keyId);
    if (owner === c) return { id: s.keyId };
    const value = answer(owner === undefined, s.keyId);
    if (how === "throw") throw value;
    return value;
  },
});
const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });
const another = "another answer for a row of customer A than for a missing row";

it.each<[string, (missing: boolean) => unknown, "throw" | "return"]>([
  [
    "a ForbiddenError and a NotFoundError",
    (missing) =>
      missing ? named("NotFoundError", "not found") : named("ForbiddenError", "forbidden"),
    "throw",
  ],
  [
    "errors that differ only in their message",
    (m) => new Error(m ? "missing" : "foreign"),
    "throw",
  ],
  [
    "errors that differ only in their code",
    (m) => Object.assign(new Error("denied"), { code: m ? "E1" : "E2" }),
    "throw",
  ],
  [
    "errors that differ only in their name",
    (m) => named(m ? "NotFoundError" : "ForbiddenError", "denied"),
    "throw",
  ],
  [
    "errors that differ only in another property (a digest, as Next.js sets one)",
    (m) =>
      Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK"), {
        digest: m ? "NEXT_HTTP_ERROR_FALLBACK;404" : "NEXT_HTTP_ERROR_FALLBACK;403",
      }),
    "throw",
  ],
  [
    "errors that differ only in a status",
    (m) => Object.assign(new Error("denied"), { status: m ? 404 : 403 }),
    "throw",
  ],
  [
    "errors that differ only in their cause",
    (m) => new Error("denied", { cause: m ? "no such row" : "not yours" }),
    "throw",
  ],
  ["two thrown strings", (m) => (m ? "not_found" : "forbidden"), "throw"],
  ["a thrown string and a thrown number that read alike", (m) => (m ? "1" : 1), "throw"],
  ["two thrown numbers", (m) => (m ? 404 : 403), "throw"],
  ["two thrown plain objects", (m) => ({ status: m ? 404 : 403 }), "throw"],
  [
    "two Error objects that are returned, not thrown",
    (m) => new Error(m ? "missing" : "forbidden"),
    "return",
  ],
  [
    "two returned errors that differ only in their code",
    (m) => Object.assign(new Error("denied"), { code: m ? "E1" : "E2" }),
    "return",
  ],
])("tells %s apart", async (_, answer, how) => {
  expect(await check(answering(answer, how))).toEqual([
    { case: "answering", check: "cross-read", detail: expect.stringContaining(another) },
  ]);
});

// An error whose code is not an own property but comes from its prototype, as a class getter does.
const withInheritedCode = (code: string): Error => {
  const error = new Error("denied");
  Object.setPrototypeOf(error, Object.create(Error.prototype, { code: { value: code } }));
  return error;
};
it("tells errors apart that differ only in a code they inherit", async () => {
  expect(await check(answering((m) => withInheritedCode(m ? "E1" : "E2"), "throw"))).toEqual([
    { case: "answering", check: "cross-read", detail: expect.stringContaining(another) },
  ]);
});

it("shows both errors in the finding: name, code and message", async () => {
  const findings = await check(
    answering(
      (m) => Object.assign(new Error(m ? "missing" : "foreign"), { name: "RowError", code: "E7" }),
      "throw",
    ),
  );
  expect(findings[0]?.detail).toBe(
    `customer B gets ${another}: ` +
      '{"threw":{"code":"E7","message":"foreign","name":"RowError"}} | ' +
      '{"threw":{"code":"E7","message":"missing","name":"RowError"}}',
  );
});

it.each<[string, (missing: boolean) => unknown, "throw" | "return"]>([
  ["the same error for a row of A and for a missing row", () => new Error("not found"), "throw"],
  [
    "the same error with a code and a property",
    () => Object.assign(new Error("denied"), { code: "E1", digest: "d" }),
    "throw",
  ],
  [
    "errors that differ only in a stack, even where it is enumerable",
    (m) => {
      const error = new Error("denied");
      Object.defineProperty(error, "stack", {
        value: m ? "at here" : "at there",
        enumerable: true,
      });
      return error;
    },
    "throw",
  ],
  ["the same thrown string", () => "not_found", "throw"],
  ["the same thrown object", () => ({ status: 404 }), "throw"],
  ["the same returned error", () => new Error("not found"), "return"],
])("passes %s", async (_, answer, how) => {
  expect(await check(answering(answer, how))).toEqual([]);
});

it("finds an error whose text holds the id of a row of A", async () => {
  const leaky = answering((_missing, keyId) => new Error(`no access to ${keyId}`), "throw");
  expect(await check(leaky)).toEqual([
    {
      case: "answering",
      check: "cross-read",
      detail: "the answer to customer B names a row of customer A",
    },
  ]);
});

// ---- an answer the helper cannot compare (B4) ------------------------------------------------

class Box {
  constructor(public x: number) {}
}
it.each<[string, unknown]>([
  ["a Map", new Map([["k", 1]])],
  ["a Set", new Set([1])],
  ["a Box", new Box(1)],
  ["a Uint8Array", new Uint8Array(2)],
  ["a Response", new Response(null, { status: 404 })],
])("refuses an answer that holds %s: the helper cannot compare it", async (kind, value) => {
  const name = kind.split(" ")[1] as string;
  const holdsIt: TenantCase<S> = { name: "holdsIt", kind: "read", run: async () => value };
  await expect(check(holdsIt)).rejects.toThrow(TypeError);
  await expect(check(holdsIt)).rejects.toThrow(`an answer holds a ${name}; return plain data`);
});

it("refuses an answer that holds a non-plain value deep inside, and a thrown error that holds one", async () => {
  const deep: TenantCase<S> = {
    name: "deep",
    kind: "read",
    run: async () => ({ rows: [{ id: 1, extra: new Box(2) }] }),
  };
  await expect(check(deep)).rejects.toThrow("an answer holds a Box; return plain data");
  const throwsBox = answering(() => Object.assign(new Error("x"), { detail: new Box(3) }), "throw");
  await expect(check(throwsBox)).rejects.toThrow("an answer holds a Box; return plain data");
});

it("accepts what JSON can show: a Date, null, an array, an object with a null prototype", async () => {
  const plain: TenantCase<S> = {
    name: "plain",
    kind: "read",
    run: async (c, s) => {
      const row = (
        await q("select id from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c])
      ).rows[0];
      return {
        row: row ?? null,
        at: new Date(0),
        list: [1, null, "x"],
        bare: Object.assign(Object.create(null) as object, { k: 1 }),
      };
    },
  };
  expect(await check(plain)).toEqual([]);
});

it("refuses a seed that holds a value the helper cannot compare, and says it is the seed", async () => {
  await expect(
    checkTenantIsolation({
      pool: t.pool,
      seed: async () => new Box(1),
      cases: [{ name: "x", kind: "read", run: async () => null }],
    }),
  ).rejects.toThrow("the seed holds a Box; return plain data");
});

// ---- the owner's own run (B5) ----------------------------------------------------------------

it("an error is not a proof that customer A finds its rows: a read whose own run throws is reported", async () => {
  const throwsForOwner: TenantCase<S> = {
    name: "throwsForOwner",
    kind: "read",
    run: async (c, s) => {
      if ((await ownerOf(s.keyId)) === c) throw new Error("boom");
      return null; // everything else, the ghost included, is a plain null
    },
  };
  expect(await check(throwsForOwner)).toEqual([
    {
      case: "throwsForOwner",
      check: "own-read",
      detail: expect.stringMatching(/threw an error.*the case proves nothing/),
    },
  ]);
});

it("a read that throws for everybody is reported once, as a case that proves nothing", async () => {
  const alwaysThrows: TenantCase<S> = {
    name: "alwaysThrows",
    kind: "read",
    run: async () => {
      throw new Error("boom");
    },
  };
  expect((await check(alwaysThrows)).map((f) => f.check)).toEqual(["own-read"]);
});

it("an error thrown for the ghost, and a row for the owner, is the way a throwing read works", async () => {
  const throwsForMissing: TenantCase<S> = {
    name: "throwsForMissing",
    kind: "read",
    run: async (c, s) => {
      const row = (
        await q("select id from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c])
      ).rows[0];
      if (row === undefined) throw new Error("not found");
      return row;
    },
  };
  expect(await check(throwsForMissing)).toEqual([]);
});
