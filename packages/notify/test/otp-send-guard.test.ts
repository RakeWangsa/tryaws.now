import { useTempDatabase } from "@tc/db/testing";
import { beforeEach, expect, it, vi } from "vitest";
import { otpTestKit } from "./kit";
import { makeSend } from "./send-helper";

vi.mock("../otp/codes", async (importOriginal) => {
  const original = await importOriginal<typeof import("../otp/codes")>();
  return { ...original, hashCode: () => "000042" };
});

const t = useTempDatabase();
const kit = otpTestKit(t);
const send = makeSend(kit);
beforeEach(kit.reset);

it("a code hash that the repository refuses is an Error, nothing is sent and no row is stored", async () => {
  const s = await kit.customer();
  await expect(send(s)).rejects.toThrow(new Error("otp: the challenge could not be stored"));
  expect(kit.sms.sent).toEqual([]);
  const rows = (
    await t.pool.query("select count(*)::int as n from otp_challenges where customer_id = $1", [
      s.customerId,
    ])
  ).rows;
  expect(rows[0].n).toBe(0);
});
