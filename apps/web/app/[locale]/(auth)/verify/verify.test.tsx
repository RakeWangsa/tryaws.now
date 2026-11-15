import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@tc/ui/runtime";
import { intl } from "../page-harness.tsx";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  session: null as null | { customerId: string },
  pending: null as null | { p: "signup" | "reset"; e: string; t: number },
  otp: true,
  steps: {} as Record<string, unknown>,
}));

vi.mock("next-intl/server", async () => {
  const { webMessages: messages } = await import("../../../../i18n/messages.ts");
  return {
    getLocale: async () => state.locale,
    getTranslations: async (options?: { locale?: "bn" | "en" }) =>
      createTranslator({
        locale: options?.locale ?? state.locale,
        messages: messages[options?.locale ?? state.locale],
      }),
  };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("../../../../server/auth-page.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../../server/auth-page.ts")>();
  return {
    ...actual,
    loadAuthPage: async () => ({
      runtime: { otp: state.otp ? {} : null },
      available: true,
      session: state.session,
    }),
    readPending: async () => state.pending,
  };
});
// The real loader reads through customerRepos(tx, session.customerId); this stand-in answers by the
// customer id it is given, which is all the page may ever pass (R8).
vi.mock("../../../../server/phone-step.ts", () => ({
  loadPhoneStep: async (session: { customerId: string }) => state.steps[session.customerId],
}));

const { default: VerifyPage } = await import("./page.tsx");

async function render(locale: Locale, query: Record<string, string | undefined> = {}) {
  state.locale = locale;
  const element = await VerifyPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(query),
  });
  return intl(element, locale);
}

const ready = (phone: string, challenge: { phoneMasked: string; resendAt: number } | null) => ({
  kind: "ready",
  phone,
  challenge,
  idempotencyKey: `key-${phone.slice(-4)}`,
});

beforeEach(() => {
  state.locale = "bn";
  state.session = null;
  state.pending = null;
  state.otp = true;
  state.steps = {};
});

describe("/verify without a session: the email step", () => {
  it("prefills the address from a valid pending cookie and shows the code field and the resend timer", async () => {
    state.pending = { p: "signup", e: "rahim@example.test", t: Math.floor(Date.now() / 1000) };
    const html = await render("en");
    expect(html).toContain('value="rahim@example.test"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain("Send the code again");
    expect(html).toContain('<i class="far fa-clock fa-2x text-warning"');
    expect(html).not.toContain('name="idempotencyKey"');
  });

  it("an empty or tampered pending cookie (null) leaves the address empty and asks for it in the resend form too", async () => {
    state.pending = null;
    const html = await render("en");
    expect(html).not.toContain("rahim@example.test");
    expect(html.match(/name="email"/g)).toHaveLength(2);
  });

  it("a reset-purpose cookie does not prefill the sign-up verification", async () => {
    state.pending = { p: "reset", e: "other@example.test", t: Math.floor(Date.now() / 1000) };
    expect(await render("en")).not.toContain("other@example.test");
  });

  it("keeps a safe next and drops a hostile one", async () => {
    expect(await render("bn", { next: "/wallet" })).toContain('name="next" value="/wallet"');
    expect(await render("bn", { next: "//evil.com" })).not.toContain("evil.com");
  });
});

describe("/verify with a session: the phone step", () => {
  it("a verified phone redirects to the landing (next kept when allowed)", async () => {
    state.session = { customerId: A };
    state.steps[A] = { kind: "verified" };
    await expect(render("bn")).rejects.toThrow("REDIRECT:/en/wallet");
    await expect(render("en", { next: "/wallet?x=1" })).rejects.toThrow("REDIRECT:/en/wallet?x=1");
    await expect(render("bn", { next: "//evil.com" })).rejects.toThrow("REDIRECT:/en/wallet");
  });

  it("shows the number prefilled and editable, and a send form carrying the server-made key", async () => {
    state.session = { customerId: A };
    state.steps[A] = ready("+8801711111111", null);
    const html = await render("en");
    expect(html).toContain('value="+8801711111111"');
    expect(html).toContain('name="idempotencyKey" value="key-1111"');
    expect(html).toContain("Send code");
    expect(html).not.toContain('autoComplete="one-time-code"');
  });

  it("with an open code it shows the masked number, the code field and the resend timer", async () => {
    state.session = { customerId: A };
    state.steps[A] = ready("+8801711111111", {
      phoneMasked: "+880*******111",
      resendAt: Math.floor(Date.now() / 1000) + 30,
    });
    const html = await render("en");
    expect(html).toContain("A code was sent to +880*******111.");
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain("Send the code again");
    expect(html).toContain("alert alert-info");
  });

  it("customer A never sees customer B's number (R8)", async () => {
    state.steps[A] = ready("+8801711111111", { phoneMasked: "+880*******111", resendAt: 0 });
    state.steps[B] = ready("+8801899999999", { phoneMasked: "+880*******999", resendAt: 0 });
    state.session = { customerId: A };
    const htmlA = await render("en");
    expect(htmlA).toContain("+880*******111");
    expect(htmlA).not.toContain("999");
    expect(htmlA).not.toContain("8801899999999");
    state.session = { customerId: B };
    const htmlB = await render("en");
    expect(htmlB).toContain("+880*******999");
    expect(htmlB).not.toContain("8801711111111");
  });

  it("without an OTP service it shows the not-available state and no form", async () => {
    state.session = { customerId: A };
    state.otp = false;
    state.steps[A] = { kind: "unavailable" };
    const html = await render("en");
    expect(html).toContain("Mobile verification is not available right now");
    expect(html).not.toContain("<form");
  });
});
