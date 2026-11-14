import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { onboardingSteps } from "@tc/core";
import { describe, expect, it } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import { DashboardContent } from "../dashboard/DashboardContent.tsx";
import { SERVER_ID, dashboard, emptyDashboard } from "../_extras/extras.fixtures.ts";

// WPU-G5: the first-use guide of the dashboard for a brand-new customer and for one with a server.
function html(locale: Locale, view = emptyDashboard, flagOff = false): string {
  const node: ReactNode = (
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      <DashboardContent locale={locale} numerals="latn" view={view} flagOff={flagOff} />
    </NextIntlClientProvider>
  );
  return renderToStaticMarkup(node);
}

describe("the dashboard guide", () => {
  it("a brand-new customer sees every step in order, the server steps locked, in bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      const out = html(locale);
      expect(out).toContain(locale === "bn" ? "শুরু করার ধাপ" : "Getting started");
      for (const href of [
        "/settings/profile",
        "/settings/security",
        "/wallet/topup",
        "/settings/ssh-keys",
        "/servers/new",
      ]) {
        expect(out).toContain(`href="${locale === "bn" ? "" : "/en"}${href}"`);
      }
      // Firewall and snapshot are locked: a lock icon and no link.
      expect(out).toContain("fa-lock");
      expect(out).not.toContain("?tab=networking");
      expect(out).not.toContain('href="/snapshots"');
    }
  });

  it("marks the first open step as the next one, by words and not by color alone", () => {
    const out = html("en");
    expect(out).toContain("Next");
    expect(out).toContain("After your first server");
  });

  it("with a server the guide continues with the firewall of that server and the snapshots page", () => {
    const out = html(
      "en",
      dashboard({
        guideServerId: SERVER_ID,
        onboarding: onboardingSteps({
          emailVerified: true,
          phoneVerified: true,
          totpEnabled: true,
          toppedUp: true,
          sshKeys: 1,
          servers: 1,
          firewallReviewed: false,
          snapshots: 0,
        }),
      }),
    );
    expect(out).toContain("Next steps");
    expect(out).toContain(`/en/servers/${SERVER_ID}?tab=networking`);
    expect(out).toContain('href="/en/snapshots"');
    expect(out).not.toContain("fa-lock");
  });

  it("the guide disappears when every step is done", () => {
    const out = html(
      "en",
      dashboard({
        onboarding: onboardingSteps({
          emailVerified: true,
          phoneVerified: true,
          totpEnabled: true,
          toppedUp: true,
          sshKeys: 1,
          servers: 1,
          firewallReviewed: true,
          snapshots: 1,
        }),
      }),
    );
    expect(out).not.toContain("Next steps");
    expect(out).not.toContain("Getting started");
  });

  it("flag off still shows the coming-soon state and no guide (R12)", () => {
    const out = html("en", emptyDashboard, true);
    expect(out).toContain("Cloud Servers are coming soon");
    expect(out).not.toContain("Getting started");
  });
});
