import { describe, expect, it } from "vitest";
import type { Tx } from "@tc/db";
import { notify, planRows, rowKey } from "../queue/notify";
import { NotifyError, TEMPLATE_IDS } from "../queue/types";
import { IDS, SAMPLES } from "./samples";

const base = { customerId: IDS.customer, dedupeKey: "k1" };

describe("planRows", () => {
  it.each(TEMPLATE_IDS)(
    "%s: one row per channel of 16.14, keyed by template, key and channel",
    (id) => {
      const rows = planRows({ ...base, template: id, data: SAMPLES[id].data });
      expect(rows.map((r) => r.channel)).toEqual(SAMPLES[id].channels);
      expect(rows.map((r) => r.dedupeKey)).toEqual(
        SAMPLES[id].channels.map((c) => `${id}:k1:${c}`),
      );
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(rows.length);
      for (const r of rows) {
        expect(r.customerId).toBe(IDS.customer);
        expect(r.template).toBe(id);
      }
    },
  );

  it("stores the parsed data: money as a decimal string, a time as ISO UTC", () => {
    const [row] = planRows({
      ...base,
      template: "topup_receipt",
      data: SAMPLES.topup_receipt.data,
    });
    expect(row?.payload).toEqual({
      paymentId: IDS.payment,
      amountMinor: "150000",
      balanceMinor: "300000",
      creditedAt: "2026-11-10T20:00:00.000Z",
    });
  });

  it("the same call twice gives the same keys (a replay conflicts)", () => {
    const a = planRows({ ...base, template: "welcome", data: {} });
    const b = planRows({ ...base, template: "welcome", data: {} });
    expect(a.map((r) => r.dedupeKey)).toEqual(b.map((r) => r.dedupeKey));
  });

  it("two messages of one event with one caller key do not collide", () => {
    const a = planRows({ ...base, template: "kyc_approved", data: SAMPLES.kyc_approved.data });
    const b = planRows({ ...base, template: "kyc_received", data: SAMPLES.kyc_received.data });
    const keys = new Set([...a, ...b].map((r) => r.dedupeKey));
    expect(keys.size).toBe(a.length + b.length);
  });

  it("a visitor (email only) gets the email row alone, with the address", () => {
    const rows = planRows({
      email: "visitor@example.test",
      template: "kyc_received",
      data: SAMPLES.kyc_received.data,
      dedupeKey: "v1",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "email",
      customerId: null,
      email: "visitor@example.test",
    });
  });

  it("a customer and an address: the address goes on the email row only (the previous address)", () => {
    const rows = planRows({
      ...base,
      email: "old@example.test",
      template: "security_email_changed",
      data: SAMPLES.security_email_changed.data,
    });
    expect(rows.find((r) => r.channel === "email")?.email).toBe("old@example.test");
    expect(rows.filter((r) => r.channel !== "email").every((r) => r.email === null)).toBe(true);
  });

  it("refuses with a fixed code and never echoes a value", () => {
    const refuse = (input: Parameters<typeof planRows>[0]): NotifyError => {
      try {
        planRows(input);
      } catch (e) {
        return e as NotifyError;
      }
      throw new Error("not refused");
    };
    const ok = { ...base, template: "welcome" as const, data: {} };
    expect(refuse({ ...ok, customerId: undefined }).code).toBe("no_recipient");
    expect(refuse({ ...ok, customerId: "not-a-uuid" }).code).toBe("bad_input");
    expect(refuse({ ...ok, email: "a b" }).code).toBe("bad_input");
    expect(refuse({ ...ok, dedupeKey: "has space" }).code).toBe("bad_input");
    expect(refuse({ ...ok, dedupeKey: "" }).code).toBe("bad_input");
    expect(refuse({ ...ok, template: "nope" as never }).code).toBe("unknown_template");
    for (const direct of [
      "phone_otp",
      "cognito_verify_code",
      "cognito_reset_code",
      "cognito_admin_temp_password",
    ]) {
      expect(refuse({ ...ok, template: direct as never, data: { code: "123456" } }).code).toBe(
        "direct_only",
      );
    }
    const err = refuse({
      ...ok,
      template: "kyc_rejected",
      data: { submissionId: IDS.submission, reason: "password: hunter2" },
    });
    expect(err.code).toBe("secret_like");
    expect(err.message).not.toContain("hunter2");
  });

  it("the OTP and a Windows password are never accepted as data of any template", () => {
    for (const id of TEMPLATE_IDS) {
      for (const k of ["code", "otp", "password", "windowsPassword", "temporaryPassword"]) {
        expect(() =>
          planRows({ ...base, template: id, data: { ...SAMPLES[id].data, [k]: "123456" } }),
        ).toThrow(NotifyError);
      }
    }
  });
});

describe("notify", () => {
  // The smallest tx that records what notify sends: insert().values().onConflictDoNothing().
  const fakeTx = () => {
    const calls: { values: unknown[]; conflict: unknown }[] = [];
    const tx = {
      insert: () => ({
        values: (v: unknown[]) => ({
          onConflictDoNothing: (...args: unknown[]) => {
            calls.push({ values: v, conflict: args[0] });
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as Tx;
    return { tx, calls };
  };

  it("inserts all rows in one statement with ON CONFLICT DO NOTHING and no conflict target", async () => {
    const { tx, calls } = fakeTx();
    await notify(tx, { ...base, template: "kyc_approved", data: SAMPLES.kyc_approved.data });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.conflict).toBeUndefined();
    expect(calls[0]?.values).toHaveLength(3);
    for (const v of calls[0]?.values as { id: string }[]) expect(v.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("writes nothing when the input is refused", async () => {
    const { tx, calls } = fakeTx();
    await expect(
      notify(tx, { ...base, template: "welcome", data: { password: "x" } }),
    ).rejects.toThrow(NotifyError);
    expect(calls).toHaveLength(0);
  });

  it("rowKey is template, key, channel", () => {
    expect(rowKey("welcome", "k", "sms")).toBe("welcome:k:sms");
  });
});
