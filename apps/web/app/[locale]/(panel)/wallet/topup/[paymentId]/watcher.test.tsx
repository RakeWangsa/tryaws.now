import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../../i18n/messages.ts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("./actions.ts", () => ({
  recheckPaymentAction: async () => ({ state: "pending", review: false }),
}));

const { PaymentWatcher } = await import("./PaymentWatcher.tsx");

// The timing rules are tested with fake timers in watcher-core.test.ts. This file checks what the
// component renders before any timer runs, and that it is wired to those rules and to nothing else.

const here = dirname(fileURLToPath(import.meta.url));

function render(locale: "bn" | "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      <PaymentWatcher paymentId="0190aaaa-0000-7000-8000-000000000001" />
    </NextIntlClientProvider>,
  );
}

describe("PaymentWatcher", () => {
  it("announces 'Checking…' in a polite live region, with an icon, in both languages", () => {
    expect(render("en")).toBe(
      '<p class="seccolor" role="status" aria-live="polite"><i class="fas fa-spinner fa-spin me-2" aria-hidden="true"></i>Checking…</p>',
    );
    expect(render("bn")).toContain("যাচাই করা হচ্ছে…");
    expect(render("bn")).toContain('aria-live="polite"');
  });

  it("is wired to the rules of watcher-core and to the one action, and checks visibility in the browser", () => {
    const source = readFileSync(resolve(here, "PaymentWatcher.tsx"), "utf8");
    expect(source).toContain("startWatcher");
    expect(source).toContain("recheckPaymentAction(paymentId)");
    expect(source).toContain('document.visibilityState === "visible"');
    expect(source).toContain("router.refresh()");
    // The cleanup of the effect is the stop function that startWatcher returns.
    expect(source).toMatch(/useEffect\(\s*\(\) =>\s*startWatcher\(/);
    expect(source).not.toMatch(/setInterval|localStorage|sessionStorage/);
  });

  it("the pending-only rule: StatusContent renders the watcher for a pending payment and not for review", () => {
    const source = readFileSync(resolve(here, "StatusContent.tsx"), "utf8");
    expect(source).toMatch(/review \? \([\s\S]*?\) : \(\s*<PaymentWatcher/);
  });
});
