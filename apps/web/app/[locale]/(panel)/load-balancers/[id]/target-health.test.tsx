import { describe, expect, it, vi } from "vitest";
import type { TargetHealthScreen } from "../../../../../server/reader-reads-view.ts";
import { html } from "../../servers/mockup-states.tsx";
import { DatabaseMetricsTab } from "../../databases/[id]/DatabaseMetricsTab.tsx";
import { TargetHealthPanel } from "./TargetHealthPanel.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-Y8: the health table and the database Metrics tab, in both languages, in every state (U11).

const ready: TargetHealthScreen = {
  state: "ready",
  checkedAt: "2026-11-13T10:00:00.000Z",
  rows: [
    { id: "a", name: "web-1", health: "healthy", reason: null },
    { id: "b", name: "web-2", health: "unhealthy", reason: "timeout" },
  ],
  counts: { healthy: 1, unhealthy: 1, initial: 0, unused: 0, draining: 0, unavailable: 0 },
  unresolved: 1,
};

const draw = (screen: TargetHealthScreen, locale: "bn" | "en") =>
  html(
    <TargetHealthPanel
      screen={screen}
      locale={locale}
      numerals={locale === "bn" ? "beng" : "latn"}
    />,
    locale,
  );

describe("TargetHealthPanel", () => {
  it("shows each server by name with the state as a word, the reason and the counts", () => {
    const out = draw(ready, "en");
    expect(out).toContain("web-1");
    expect(out).toContain("Healthy");
    expect(out).toContain("Not healthy");
    expect(out).toContain("The server did not answer in time");
    expect(out).not.toMatch(/tc-(instance|lb)-|arn:|\sstyle=|<script/);
  });

  it("is written in Bengali for bn", () => {
    expect(draw(ready, "bn")).toContain("সুস্থ");
  });

  it("has an unavailable, a not-live and an empty state", () => {
    expect(draw({ state: "unavailable" }, "en")).toContain("Health cannot be shown now");
    expect(draw({ state: "not_live" }, "en")).toContain("No health to show yet");
    expect(draw({ state: "empty", checkedAt: "2026-11-13T10:00:00.000Z" }, "en")).toContain(
      "No server to check",
    );
  });
});

describe("DatabaseMetricsTab", () => {
  const points = [{ at: "2026-11-13T10:00:00.000Z", value: 5 }];
  const ok = (locale: "bn" | "en") =>
    html(
      <DatabaseMetricsTab
        databaseId="0190aaaa-0000-7000-8000-0000000000a1"
        locale={locale}
        numerals={locale === "bn" ? "beng" : "latn"}
        screen={{
          state: "ready",
          range: "1d",
          series: [
            { metric: "cpu", unit: "percent", statistic: "average", periodSeconds: 900, points },
            {
              metric: "freeStorage",
              unit: "bytes",
              statistic: "minimum",
              periodSeconds: 900,
              points,
            },
          ],
        }}
      />,
      locale,
    );

  it("has the range selector as links, the series names and the meaning of a point", () => {
    const out = ok("en");
    expect(out).toContain("tab=metrics&amp;range=1h");
    expect(out).toContain("tab=metrics&amp;range=1w");
    expect(out).toContain("CPU use");
    expect(out).toContain("Free storage");
    expect(out).toContain("Each point is the average over 15 minutes.");
    expect(out).toContain("Each point is the lowest value in 15 minutes.");
    expect(out).not.toMatch(/\sstyle=|<script/);
  });

  it("is in Bengali for bn and has unavailable and empty states", () => {
    expect(ok("bn")).toContain("ফাঁকা স্টোরেজ");
    const draw = (screen: Parameters<typeof DatabaseMetricsTab>[0]["screen"]) =>
      html(<DatabaseMetricsTab databaseId="x" locale="en" numerals="latn" screen={screen} />, "en");
    expect(draw({ state: "unavailable" })).toContain("Metrics cannot be shown now");
    expect(draw({ state: "empty", range: "1h" })).toContain("No metrics yet");
  });
});
