import type { Orders } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  MAX_ENVELOPED_TOKEN,
  envelopeOrders,
  openDraftToken,
  sealDraftToken,
} from "./draft-envelope.ts";

// WPU-X10 review fix 3 (U6): the signed draft token is readable by its holder (base64 JSON). A domain draft holds
// the KMS ciphertext of the contact, and a KMS ciphertext names its key ARN, so the account id. The web tier
// therefore hands the browser only an AES-256-GCM envelope of the token (key from the OrderDraftSecret, HKDF) and
// opens it again before core sees it. No new dependency: node:crypto.

const SECRET = new Uint8Array(32).fill(7);
const OLD = new Uint8Array(32).fill(9);
const ARN = "arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
// What a KMS ciphertext looks like for this test: bytes that carry the key ARN.
const SEALED = Buffer.concat([Buffer.from([1, 2, 0, 75]), Buffer.from(ARN), Buffer.alloc(64, 5)]);

// The shape of a signed draft of core (base64url JSON claims "." base64url MAC); the MAC is not checked here.
function domainToken(): string {
  const claims = {
    v: 1,
    c: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    fam: "domain",
    pid: "11111111-2222-4333-8444-555555555555",
    region: "us-east-1",
    cfg: { name: "example.com", contactSealed: SEALED.toString("base64") },
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${Buffer.alloc(32, 3).toString("base64url")}`;
}

/** Every text a holder of the envelope can decode from it: the raw text, base64url and base64 of each part. */
function decodedViews(text: string): string {
  const parts = text.split(".");
  const views = [text];
  for (const part of parts) {
    views.push(Buffer.from(part, "base64url").toString("latin1"));
    views.push(Buffer.from(part, "base64").toString("latin1"));
  }
  return views.join("\n");
}

describe("sealDraftToken and openDraftToken", () => {
  it("the inner token (with the ARN inside the contact ciphertext) shows the account id; the envelope does not", () => {
    const inner = domainToken();
    // the problem: the signed token alone leaks it after two base64 decodings
    const claims = JSON.parse(Buffer.from(inner.split(".")[0]!, "base64url").toString("utf8"));
    expect(Buffer.from(claims.cfg.contactSealed, "base64").toString("latin1")).toContain("arn:");
    const sealed = sealDraftToken([SECRET], inner);
    expect(sealed.startsWith("e1.")).toBe(true);
    const views = decodedViews(sealed);
    expect(views).not.toContain("arn:");
    expect(views).not.toMatch(/\d{12}/);
    expect(views).not.toContain("example.com");
    expect(openDraftToken([SECRET], sealed)).toBe(inner);
  });

  it("opens with an older secret of the rotation list, and refuses a changed, foreign or oversized envelope", () => {
    const inner = domainToken();
    const sealed = sealDraftToken([OLD], inner);
    expect(openDraftToken([SECRET, OLD], sealed)).toBe(inner);
    expect(openDraftToken([SECRET], sealed)).toBeNull();
    const body = Buffer.from(sealed.slice(3), "base64url");
    body[20] = (body[20] ?? 0) ^ 1;
    expect(openDraftToken([OLD], `e1.${body.toString("base64url")}`)).toBeNull();
    expect(openDraftToken([SECRET], "e1.")).toBeNull();
    expect(openDraftToken([SECRET], "e1.!!!")).toBeNull();
    expect(openDraftToken([SECRET], `e1.${"A".repeat(MAX_ENVELOPED_TOKEN)}`)).toBeNull();
  });

  it("two envelopes of one token differ (random IV) and both open to the same token", () => {
    const inner = domainToken();
    const a = sealDraftToken([SECRET], inner);
    const b = sealDraftToken([SECRET], inner);
    expect(a).not.toBe(b);
    expect(openDraftToken([SECRET], a)).toBe(inner);
    expect(openDraftToken([SECRET], b)).toBe(inner);
  });

  it("a plain token passes through unchanged (only the server ever had one)", () => {
    expect(openDraftToken([SECRET], "abc.def")).toBe("abc.def");
  });

  it("an envelope of the largest signed draft fits the limit of the review form", () => {
    const sealed = sealDraftToken([SECRET], "x".repeat(4096));
    expect(sealed.length).toBeLessThanOrEqual(MAX_ENVELOPED_TOKEN);
  });
});

describe("envelopeOrders", () => {
  function fakeOrders() {
    const placed: string[] = [];
    const inner = domainToken();
    const orders: Orders = {
      createOrderDraft: async () => ({
        ok: true,
        value: { token: inner, quote: {} as never, expiresAt: new Date() },
      }),
      placeOrder: async (_s, input) => {
        placed.push(input.token);
        if (input.token === "price") {
          return {
            ok: false,
            error: "price_changed",
            data: { token: inner, quote: {} as never, expiresAt: new Date() },
          } as never;
        }
        return { ok: true, value: { orderId: "o-1" } };
      },
    };
    return { orders, placed, inner };
  }

  it("hands out envelopes and gives core the inner token back", async () => {
    const { orders, placed, inner } = fakeOrders();
    const wrapped = envelopeOrders(orders, [SECRET]);
    const draft = await wrapped.createOrderDraft({} as never, {});
    if (!draft.ok) throw new Error("draft");
    expect(draft.value.token.startsWith("e1.")).toBe(true);
    expect(decodedViews(draft.value.token)).not.toContain("arn:");
    expect(
      await wrapped.placeOrder({} as never, { token: draft.value.token, idempotencyKey: "k" }),
    ).toEqual({ ok: true, value: { orderId: "o-1" } });
    expect(placed).toEqual([inner]);
  });

  it("wraps the fresh draft of price_changed, and refuses an envelope it cannot open before core sees it", async () => {
    const { orders, placed } = fakeOrders();
    const wrapped = envelopeOrders(orders, [SECRET]);
    const changed = await wrapped.placeOrder({} as never, { token: "price", idempotencyKey: "k" });
    expect(changed.ok).toBe(false);
    const data = (changed as { data: { token: string } }).data;
    expect(data.token.startsWith("e1.")).toBe(true);
    const refused = await wrapped.placeOrder({} as never, {
      token: "e1.AAAA",
      idempotencyKey: "k",
    });
    expect(refused).toMatchObject({ ok: false, error: "validation", fields: { token: "invalid" } });
    expect(placed).toEqual(["price"]);
  });
});
