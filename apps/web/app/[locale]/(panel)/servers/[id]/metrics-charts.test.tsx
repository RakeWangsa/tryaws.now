import { describe, expect, it, vi } from "vitest";
import type { MetricSeriesView } from "../../../../../server/extras-view.ts";
import { html } from "../mockup-states.tsx";
import { MetricChart } from "./MetricsCharts.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-G4: the charts of the Metrics tab (console parity): CPU, network in and out, status checks.

const points = (values: number[]) =>
  values.map((value, i) => ({
    at: new Date(Date.UTC(2026, 10, 12, 1, 0, 0) + i * 300_000).toISOString(),
    value,
  }));
const cpu: MetricSeriesView = { metric: "cpu", unit: "percent", points: points([10, 60, 30]) };
const net: MetricSeriesView = {
  metric: "networkOut",
  unit: "bytes",
  points: points([2_000_000, 8_000_000, 5_000_000]),
};
const status = (values: number[]): MetricSeriesView => ({
  metric: "statusCheckFailed",
  unit: "count",
  points: points(values),
});

const draw = (series: MetricSeriesView, locale: "bn" | "en" = "en", range: "1h" | "1w" = "1h") =>
  html(
    <MetricChart
      series={series}
      name={series.metric}
      locale={locale}
      numerals={locale === "bn" ? "beng" : "latn"}
      range={range}
    />,
    locale,
  );

describe("MetricChart", () => {
  it("draws an SVG that scales to the width of a phone, with no style attribute and no script (U4)", () => {
    const out = draw(cpu);
    expect(out).toContain("<svg");
    expect(out).toContain('class="w-100 mergecolor"');
    expect(out).toContain('viewBox="0 0 640 220"');
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/\s(?:width|height)="\d+"/);
  });

  it("names the value axis with its unit, and picks the unit of a byte series", () => {
    expect(draw(cpu)).toContain(">%</text>");
    const out = draw(net);
    expect(out).toContain(">MB</text>");
    expect(out).toContain("Latest: 4.8 MB");
  });

  it("writes the time axis in Dhaka time, the date for a week and Bengali digits in bn", () => {
    expect(draw(cpu)).toMatch(/7:00 AM/);
    expect(draw(cpu, "en", "1w")).toMatch(/Nov 12, 2026/);
    expect(draw(cpu, "bn")).toMatch(/[০-৯]/);
    expect(draw(cpu, "bn")).toMatch(/[ঀ-৿]/);
  });

  it("says the state of the status checks in words, not by colour", () => {
    expect(draw(status([0, 0, 0]))).toContain("Passing");
    expect(draw(status([0, 1, 0]))).toContain("Failed earlier, passing now");
    expect(draw(status([0, 0, 1]))).toContain("Failing now");
    expect(draw(status([0, 0, 0]), "bn")).toContain("ঠিক আছে");
  });

  it("shows no raw metric name or number text from the reader other than the formatted values", () => {
    const out = draw(cpu);
    expect(out).not.toMatch(/arn:aws|\b\d{12}\b/);
  });

  it("says that nothing is usable when no point survives", () => {
    const empty = draw({ metric: "cpu", unit: "percent", points: [{ at: "x", value: 1 }] });
    expect(empty).toContain("No usable data");
    expect(empty).not.toContain("<svg");
  });
});
