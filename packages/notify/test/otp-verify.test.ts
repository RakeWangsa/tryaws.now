import { randomUUID } from "node:crypto";
import { customerRepos, type Tx } from "@tc/db";
import { newCustomer, runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeEach, expect, it } from "vitest";
import { hashCode } from "../otp/codes";
import type { OtpDeps } from "../otp/deps";
import { verifyPhoneOtp } from "../otp/verify";
import { PEPPER, fixedClock } from "./harness";

const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const clock = fixedClock();
const deps = (over: Partial<OtpDeps> = {}): OtpDeps => ({ run, clock, pepper: PEPPER, ...over });
const customer = async () => ({ customerId: await newCustomer(t.pool) });
const PHONE = "+8801712345678";
const START = "2026-11-11T10:00:00.000Z";
beforeEach(() => clock.set(START));

/** An open challenge for `code`, issued at the clock's time, the way sendPhoneOtp stores it. */
async function open(customerId: string, code: string, phone = PHONE): Promise<string> {
  const id = randomUUID(); // the repository accepts any UUID; the service derives its own
  const now = clock.now();
  await run((tx) =>
    customerRepos(tx, customerId).otp.issue({
      id,
      phone,
      codeHash: hashCode(PEPPER, id, phone, code),
      expiresAt: new Date(now.getTime() + 300_000),
      now,
    }),
  );
  return id;
}
const verify = (s: { customerId: string }, code: string, d: OtpDeps = deps()) =>
  verifyPhoneOtp(d, s, { code });
const state = async (id: string) =>
  (await t.pool.query("select attempts, consumed_at from otp_challenges where id = $1", [id]))
    .rows[0];
const profile = async (customerId: string) =>
  (await t.pool.query("select phone, phone_verified_at from customers where id = $1", [customerId]))
    .rows[0];

it("the right code verifies: the number and the time are stored and the challenge is used up", async () => {
  const s = await customer();
  const id = await open(s.customerId, "123456");
  clock.advanceSeconds(30);
  const at = new Date("2026-11-11T10:00:30.000Z");
  expect(await verify(s, "123456")).toEqual({
    ok: true,
    value: { phoneMasked: "+880*******678", verifiedAt: at },
  });
  expect(await profile(s.customerId)).toEqual({ phone: PHONE, phone_verified_at: at });
  expect(await state(id)).toEqual({ attempts: 1, consumed_at: at });
});

it.each([["000042"], ["০০০০৪২"], [" 000 042 "]])(
  "the code 000042 typed as %j verifies",
  async (typed) => {
    const s = await customer();
    await open(s.customerId, "000042");
    expect((await verify(s, typed)).ok).toBe(true);
  },
);

it("a code that lost its zeros is malformed and does not count as an attempt", async () => {
  const s = await customer();
  const id = await open(s.customerId, "000042");
  expect(await verify(s, "42")).toEqual({
    ok: false,
    error: "validation",
    fields: { code: "malformed" },
  });
  expect((await state(id)).attempts).toBe(0);
});

it("five wrong codes use up the challenge, the counts are kept, and the sixth call is refused even with the right code", async () => {
  const s = await customer();
  const id = await open(s.customerId, "123456");
  for (const left of [4, 3, 2, 1, 0]) {
    expect(await verify(s, "654321")).toEqual({
      ok: false,
      error: "validation",
      fields: { code: "wrong" },
      data: { attemptsLeft: left },
    });
  }
  expect((await state(id)).attempts).toBe(5);
  expect(await verify(s, "123456")).toEqual({ ok: false, error: "limit_reached" });
  expect(await profile(s.customerId)).toMatchObject({ phone_verified_at: null });
});

it("the fifth attempt may still be the right one", async () => {
  const s = await customer();
  await open(s.customerId, "123456");
  for (let i = 0; i < 4; i++) await verify(s, "654321");
  expect((await verify(s, "123456")).ok).toBe(true);
});

it("a code verifies once: the second call finds no open code and changes nothing", async () => {
  const s = await customer();
  await open(s.customerId, "123456");
  await verify(s, "123456");
  const first = await profile(s.customerId);
  clock.advanceSeconds(60);
  expect(await verify(s, "123456")).toEqual({ ok: false, error: "not_found" });
  expect(await profile(s.customerId)).toEqual(first);
});

it.each([
  ["valid 1 ms before the expiry", 299_999, true],
  ["closed at the expiry", 300_000, false],
  ["a verifier clock 59 s behind the issuer", -59_000, true],
  ["a verifier clock 61 s behind the issuer", -61_000, false],
])("%s", async (_, ms, ok) => {
  const s = await customer();
  await open(s.customerId, "123456");
  clock.set(new Date(Date.parse(START) + ms).toISOString());
  expect((await verify(s, "123456")).ok).toBe(ok);
  if (!ok) expect(await verify(s, "123456")).toEqual({ ok: false, error: "not_found" });
});

it("a customer with no challenge gets not_found, and another customer's code does nothing", async () => {
  const a = await customer();
  const b = await customer();
  const id = await open(a.customerId, "123456");
  expect(await verify(b, "123456")).toEqual({ ok: false, error: "not_found" });
  expect((await state(id)).attempts).toBe(0);
});

it("two verifications with the right code at the same moment: one wins, the other finds no open code", async () => {
  const s = await customer();
  await open(s.customerId, "123456");
  const results = await Promise.all([verify(s, "123456"), verify(s, "123456")]);
  expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["not_found", "ok"]);
  expect((await profile(s.customerId)).phone_verified_at).not.toBeNull();
});

it("eight wrong codes at the same moment: exactly five are counted, the other three see the challenge used up", async () => {
  const s = await customer();
  const id = await open(s.customerId, "123456");
  const results = await Promise.all(Array.from({ length: 8 }, () => verify(s, "654321")));
  expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual([
    "limit_reached",
    "limit_reached",
    "limit_reached",
    "validation",
    "validation",
    "validation",
    "validation",
    "validation",
  ]);
  expect((await state(id)).attempts).toBe(5);
});

it("only the newest challenge verifies: the code of the one before is wrong and counts against the newest", async () => {
  const s = await customer();
  await open(s.customerId, "111111");
  clock.advanceSeconds(60);
  const newest = await open(s.customerId, "222222");
  expect(await verify(s, "111111")).toEqual({
    ok: false,
    error: "validation",
    fields: { code: "wrong" },
    data: { attemptsLeft: 4 },
  });
  expect((await verify(s, "222222")).ok).toBe(true);
  expect((await state(newest)).attempts).toBe(2);
});

it("a send that commits while a verification waits for the old challenge: not_found, and no attempt is counted anywhere", async () => {
  const s = await customer();
  const oldId = await open(s.customerId, "111111");
  clock.advanceSeconds(10);
  const newId = randomUUID();
  const now = clock.now();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let issued!: () => void;
  const hasIssued = new Promise<void>((r) => (issued = r));
  const sending = run(async (tx) => {
    // the send of a newer code: it closes the old challenge and inserts the new one, then keeps its row locks
    const r = await customerRepos(tx, s.customerId).otp.issue({
      id: newId,
      phone: PHONE,
      codeHash: hashCode(PEPPER, newId, PHONE, "222222"),
      expiresAt: new Date(now.getTime() + 300_000),
      now,
    });
    issued();
    await gate;
    return r;
  });
  await hasIssued;
  const verifying = verify(s, "111111"); // its claim read the old challenge as the newest and now waits on the row lock
  for (let i = 0; i < 100; i++) {
    const n = (
      await t.pool.query(
        "select count(*)::int as n from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and state = 'active'",
        [t.name],
      )
    ).rows[0].n;
    if (n === 1) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  release();
  await sending;
  expect(await verifying).toEqual({ ok: false, error: "not_found" });
  expect((await state(oldId)).attempts).toBe(0);
  expect((await state(newId)).attempts).toBe(0);
});

it("a challenge for a new number replaces the verified number", async () => {
  const s = await customer();
  await open(s.customerId, "111111");
  await verify(s, "111111");
  clock.advanceSeconds(60);
  await open(s.customerId, "222222", "+8801812345678");
  clock.advanceSeconds(1);
  expect(await verify(s, "222222")).toMatchObject({
    ok: true,
    value: { phoneMasked: "+880*******678" },
  });
  expect((await profile(s.customerId)).phone).toBe("+8801812345678");
});

it("a key shorter than 32 characters is a TypeError and counts nothing", async () => {
  const s = await customer();
  const id = await open(s.customerId, "123456");
  await expect(verify(s, "123456", deps({ pepper: "short" }))).rejects.toThrow(TypeError);
  expect((await state(id)).attempts).toBe(0);
});
