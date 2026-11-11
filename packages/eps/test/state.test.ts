import { describe, expect, it } from "vitest";
import { OPEN_STATES, PAYMENT_STATES, canMove, isOpen, publicState } from "../state";
import type { PaymentState } from "../state";

// The table of the plan, written out. Every other pair must be false.
const ALLOWED: Record<PaymentState, readonly PaymentState[]> = {
  initiated: ["redirected", "credited", "failed", "cancelled", "expired", "review"],
  redirected: ["credited", "failed", "cancelled", "expired", "review"],
  credited: [],
  failed: ["review"],
  cancelled: ["review"],
  expired: ["review"],
  review: [],
};

describe("states", () => {
  it("are the seven values of payments_status_check, in order", () => {
    expect(PAYMENT_STATES).toEqual([
      "initiated",
      "redirected",
      "credited",
      "failed",
      "cancelled",
      "expired",
      "review",
    ]);
    expect(OPEN_STATES).toEqual(["initiated", "redirected"]);
  });

  it("are open only when initiated or redirected", () => {
    for (const s of PAYMENT_STATES)
      expect(isOpen(s), s).toBe(OPEN_STATES.includes(s as "initiated"));
  });
});

describe("canMove", () => {
  for (const from of PAYMENT_STATES) {
    for (const to of PAYMENT_STATES) {
      it(`${from} -> ${to} is ${ALLOWED[from].includes(to)}`, () => {
        expect(canMove(from, to)).toBe(ALLOWED[from].includes(to));
      });
    }
  }

  it("lets nothing leave credited or review and nothing enter initiated", () => {
    for (const to of PAYMENT_STATES) {
      expect(canMove("credited", to)).toBe(false);
      expect(canMove("review", to)).toBe(false);
      expect(canMove(to, "initiated")).toBe(false);
    }
  });

  it("only redirects from initiated", () => {
    expect(canMove("initiated", "redirected")).toBe(true);
    expect(canMove("redirected", "redirected")).toBe(false);
    expect(canMove("failed", "redirected")).toBe(false);
  });

  it("answers false for text that is not a state", () => {
    expect(canMove("done" as PaymentState, "credited")).toBe(false);
    expect(canMove("initiated", "paid" as PaymentState)).toBe(false);
  });
});

describe("publicState", () => {
  it("shows initiated, redirected and review as pending (9.2.4 and F)", () => {
    expect(publicState("initiated")).toBe("pending");
    expect(publicState("redirected")).toBe("pending");
    expect(publicState("review")).toBe("pending");
  });

  it("passes the others through", () => {
    expect(publicState("credited")).toBe("credited");
    expect(publicState("failed")).toBe("failed");
    expect(publicState("cancelled")).toBe("cancelled");
    expect(publicState("expired")).toBe("expired");
  });
});
