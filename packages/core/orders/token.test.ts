import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { quote, toSnapshot, type PricingRule } from "../pricing/index";
import { assertSecrets, signDraft, verifyDraft } from "./token";
import { DRAFT_MAX_BYTES, DRAFT_TTL_SECONDS, type DraftClaims } from "./types";

const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "markup", rate: "0.20", base: "aws", label },
  ],
};
const SECRET_1 = new Uint8Array(32).fill(1);
const SECRET_2 = new Uint8Array(32).fill(2);
const SECRET_3 = new Uint8Array(32).fill(3);
const CUSTOMER = "0190aaaa-0000-7000-8000-000000000001";
const IAT = 1_800_000_000;

function snap() {
  const q = quote({ awsPriceUsd: "3.50", fxRate: "122.5", rule: RULE });
  return toSnapshot(q, { awsPriceUsd: "3.50", pricedAt: new Date(IAT * 1000) });
}
function claims(): DraftClaims {
  return {
    v: 1,
    c: CUSTOMER,
    fam: "linux_instance",
    pid: "nano_3_0",
    region: "ap-south-1",
    cfg: { blueprint: "ubuntu_22_04" },
    snap: snap(),
    iat: IAT,
    exp: IAT + DRAFT_TTL_SECONDS,
  };
}
/** Signs arbitrary claims, bypassing the shape check, to prove verifyDraft re-validates. */
function forge(secret: Uint8Array, payload: unknown): string {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(p).digest("base64url");
  return `${p}.${mac}`;
}
const at = (s: number) => new Date(s * 1000);

describe("signDraft and verifyDraft", () => {
  it("(a) round trips the claims", () => {
    const c = claims();
    const v = verifyDraft([SECRET_1], signDraft([SECRET_1], c), at(IAT + 10));
    expect(v).toEqual({ ok: true, claims: c });
  });

  it("is deterministic for the same claims", () => {
    expect(signDraft([SECRET_1], claims())).toBe(signDraft([SECRET_1], claims()));
  });

  it("(b) refuses a changed payload, a changed mac and a missing dot", () => {
    const token = signDraft([SECRET_1], claims());
    const [p, m] = token.split(".") as [string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const verdicts = [
      verifyDraft([SECRET_1], `${flip(p)}.${m}`, at(IAT)),
      verifyDraft([SECRET_1], `${p}.${flip(m)}`, at(IAT)),
      verifyDraft([SECRET_1], `${p}${m}`, at(IAT)),
      verifyDraft([SECRET_1], `${p}.${m}.x`, at(IAT)),
      verifyDraft([SECRET_1], "", at(IAT)),
    ];
    for (const v of verdicts) {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(["signature", "malformed"]).toContain(v.reason);
    }
  });

  it("(b2) accepts only the canonical mac text: the spare bits of the last character make no second token", () => {
    // 43 base64url characters carry 258 bits for a 256-bit mac, so four last characters decode to the same
    // bytes. The ledger key and the order id come from the token text; each variant would be a new order.
    const token = signDraft([SECRET_1], claims());
    const [p, m] = token.split(".") as [string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const variants = [...alphabet]
      .map((ch) => `${p}.${m.slice(0, -1)}${ch}`)
      .filter((t) => t !== token)
      .filter((t) =>
        Buffer.from(t.split(".")[1] as string, "base64url").equals(Buffer.from(m, "base64url")),
      );
    expect(variants.length).toBe(3); // the same bytes under three other texts
    for (const t of variants) {
      const v = verifyDraft([SECRET_1], t, at(IAT));
      expect(v.ok).toBe(false);
    }
    expect(verifyDraft([SECRET_1], token, at(IAT)).ok).toBe(true);
  });

  it("(c) is expired at exp and fine one second before", () => {
    const token = signDraft([SECRET_1], claims());
    const exp = IAT + DRAFT_TTL_SECONDS;
    expect(verifyDraft([SECRET_1], token, at(exp - 1)).ok).toBe(true);
    expect(verifyDraft([SECRET_1], token, at(exp))).toEqual({ ok: false, reason: "expired" });
  });

  it("(d) accepts any listed secret and refuses an unknown one", () => {
    const token = signDraft([SECRET_2], claims());
    expect(verifyDraft([SECRET_1, SECRET_2], token, at(IAT)).ok).toBe(true);
    expect(verifyDraft([SECRET_1, SECRET_3], token, at(IAT))).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("signs with the first secret only", () => {
    const token = signDraft([SECRET_1, SECRET_2], claims());
    expect(verifyDraft([SECRET_1], token, at(IAT)).ok).toBe(true);
    expect(verifyDraft([SECRET_2], token, at(IAT)).ok).toBe(false);
  });

  it("(e2) assertSecrets refuses more than three keys (a rotation list stays short)", () => {
    expect(() => assertSecrets([SECRET_1, SECRET_2, SECRET_1])).not.toThrow();
    expect(() => assertSecrets([SECRET_1, SECRET_2, SECRET_1, SECRET_2])).toThrow(TypeError);
    expect(() => verifyDraft([SECRET_1, SECRET_2, SECRET_1, SECRET_2], "a.b", at(IAT))).toThrow(
      TypeError,
    );
  });

  it("(e) assertSecrets refuses an empty list and a short key", () => {
    expect(() => assertSecrets([])).toThrow("orders: the draft secret is missing or too short");
    expect(() => assertSecrets([new Uint8Array(31)])).toThrow(TypeError);
    expect(() => assertSecrets([SECRET_1, new Uint8Array(31)])).toThrow(TypeError);
    expect(() => assertSecrets([SECRET_1, SECRET_2])).not.toThrow();
    expect(() => signDraft([], claims())).toThrow(TypeError);
    expect(() => verifyDraft([], "a.b", at(IAT))).toThrow(TypeError);
  });

  it("(f) refuses a token over the size limit without decoding it", () => {
    const big = "A".repeat(5 * 1024 * 1024);
    const t0 = performance.now();
    const v = verifyDraft([SECRET_1], big, at(IAT));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(v).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDraft([SECRET_1], "A".repeat(DRAFT_MAX_BYTES + 1), at(IAT))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("(g) re-validates the claims after a valid mac", () => {
    const good = claims();
    const cases: [string, unknown][] = [
      ["v 2", { ...good, v: 2 }],
      ["cfg array", { ...good, cfg: [] }],
      ["snap not a snapshot", { ...good, snap: { v: 1 } }],
      ["exp equal iat", { ...good, exp: IAT }],
      ["exp before iat", { ...good, exp: IAT - 1 }],
      ["too long a life", { ...good, exp: IAT + DRAFT_TTL_SECONDS + 1 }],
      ["c not a uuid", { ...good, c: "not-a-uuid" }],
      ["empty fam", { ...good, fam: "" }],
      ["long region", { ...good, region: "r".repeat(65) }],
      ["float iat", { ...good, iat: 1.5 }],
      ["extra field", { ...good, extra: 1 }],
      ["not an object", [1, 2]],
    ];
    for (const [name, payload] of cases) {
      const v = verifyDraft([SECRET_1], forge(SECRET_1, payload), at(IAT));
      expect({ name, v }).toEqual({ name, v: { ok: false, reason: "malformed" } });
    }
  });

  it("(g) refuses a payload that is not JSON", () => {
    const p = Buffer.from("not json").toString("base64url");
    const mac = createHmac("sha256", SECRET_1).update(p).digest("base64url");
    expect(verifyDraft([SECRET_1], `${p}.${mac}`, at(IAT))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("(h) never puts the token into a verdict", () => {
    const token = signDraft([SECRET_1], claims());
    const [p] = token.split(".") as [string];
    const tampered = `${p}.${"A".repeat(43)}`;
    for (const t of [tampered, "x.y", token]) {
      const v = verifyDraft([SECRET_1], t, at(IAT + DRAFT_TTL_SECONDS));
      expect(JSON.stringify(v)).not.toContain(t);
    }
  });
});
