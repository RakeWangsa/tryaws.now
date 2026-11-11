import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  boundTo: [] as string[],
  statementArgs: [] as unknown[],
  payments: [] as { id: string; status: string }[],
}));

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => {
    state.boundTo.push(customerId);
    return {
      wallet: {
        view: async () => ({ balanceMinor: 150000n, currency: "BDT" }),
        statement: async (args: unknown) => {
          state.statementArgs.push(args);
          return { lines: [], nextCursor: null };
        },
      },
      payments: { list: async () => state.payments },
    };
  },
}));

const { bannerFor, kindKey, loadWallet } = await import("./wallet-view.ts");
const { publicPaymentState, isWaiting } = await import("./payment-state.ts");
const { PAYMENT_STATES, publicState } = await import("@tc/eps");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("loadWallet is bound to the customer of the session (R8)", () => {
  it("builds the repositories of the session's customer and of nobody else", async () => {
    state.boundTo = [];
    state.payments = [{ id: "p1", status: "redirected" }];
    const screen = await loadWallet({ customerId: A } as never, { cursor: `1.${B}` });
    expect(state.boundTo).toEqual([A]);
    expect(screen.balanceMinor).toBe(150000n);
    expect(screen.waitingCount).toBe(1);
    // The cursor is passed on as an opaque string; the repository refuses a malformed one.
    expect(state.statementArgs.at(-1)).toEqual({ limit: 20, cursor: `1.${B}` });
  });

  it("shows ten payments, counts the waiting ones over the last hundred, and newest is the first", async () => {
    state.payments = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      status: i === 11 ? "initiated" : "credited",
    }));
    const screen = await loadWallet({ customerId: A } as never);
    expect(screen.payments).toHaveLength(10);
    expect(screen.newest?.id).toBe("p0");
    expect(screen.waitingCount).toBe(1);
  });
});

describe("payment-state keeps the table of @tc/eps", () => {
  it("answers what publicState answers for every stored state, and pending for the unknown", () => {
    for (const status of PAYMENT_STATES) {
      expect(publicPaymentState(status), status).toBe(publicState(status));
    }
    expect(publicPaymentState("something-new")).toBe("pending");
    expect(isWaiting("review")).toBe(true);
    expect(isWaiting("credited")).toBe(false);
  });
});

describe("bannerFor", () => {
  const row = (status: string) => ({ status }) as never;

  it("needs the customer's own credited row for the success text", () => {
    expect(bannerFor("credited", row("credited"))).toBe("credited");
    expect(bannerFor("credited", row("redirected"))).toBe("checking");
    expect(bannerFor("credited", null)).toBe("checking");
  });

  it("matches only the six fixed values, case sensitive", () => {
    expect(bannerFor("pending", null)).toBe("checking");
    for (const value of ["failed", "cancelled", "expired", "unknown"]) {
      expect(bannerFor(value, null)).toBe(value);
    }
    for (const value of ["FAILED", "", "failed ", "x", 1, undefined, ["failed"], {}]) {
      expect(bannerFor(value, null)).toBeNull();
    }
  });

  it("kindKey knows the ledger kinds and calls the rest other", () => {
    expect(kindKey("topup")).toBe("topup");
    expect(kindKey("metered_charge")).toBe("metered_charge");
    expect(kindKey("staff <b>text</b>")).toBe("other");
  });
});

describe("no float on an amount in the wallet files (R4)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    resolve(here, "wallet-view.ts"),
    resolve(here, "../app/[locale]/(panel)/wallet/WalletContent.tsx"),
    resolve(here, "../app/[locale]/(panel)/wallet/page.tsx"),
  ];
  it.each(files)("%s", (file) => {
    const text = readFileSync(file, "utf8");
    for (const banned of ["Number(", "parseInt(", "parseFloat(", "toFixed("]) {
      expect(text.includes(banned), banned).toBe(false);
    }
  });
});
