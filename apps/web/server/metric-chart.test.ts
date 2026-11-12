import { describe, expect, it } from "vitest";
import { buildChart, bytesScale, niceMax, statusOf } from "./metric-chart.ts";
import type { MetricSeriesView } from "./extras-view.ts";

// WPU-G4: the geometry of the charts of the Metrics tab is pure and tested without a renderer.

const series = (
  metric: MetricSeriesView["metric"],
  unit: MetricSeriesView["unit"],
  values: number[],
  stepMs = 300_000,
): MetricSeriesView => ({
  metric,
  unit,
  points: values.map((value, i) => ({
    at: new Date(Date.UTC(2026, 10, 12, 1, 0, 0) + i * stepMs).toISOString(),
    value,
  })),
});

describe("niceMax", () => {
  it("rounds up to 1, 2, 5 times a power of ten and never returns less than 1", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.1)).toBe(2);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(4300)).toBe(5000);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("bytesScale", () => {
  it("picks the unit of the largest value", () => {
    expect(bytesScale(10)).toEqual({ unit: "B", divisor: 1 });
    expect(bytesScale(5_000)).toEqual({ unit: "KB", divisor: 1024 });
    expect(bytesScale(5 * 1024 * 1024)).toEqual({ unit: "MB", divisor: 1024 ** 2 });
    expect(bytesScale(5 * 1024 ** 3)).toEqual({ unit: "GB", divisor: 1024 ** 3 });
    expect(bytesScale(Number.NaN)).toEqual({ unit: "B", divisor: 1 });
  });
});

describe("buildChart", () => {
  it("keeps a percent axis at 0 to 100 and puts the points by time, oldest at the left", () => {
    const chart = buildChart(series("cpu", "percent", [0, 50, 100]));
    expect(chart).not.toBeNull();
    expect(chart!.yTicks.map((t) => t.value)).toEqual([0, 50, 100]);
    expect(chart!.dots).toHaveLength(3);
    const [a, b, c] = chart!.dots;
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    // 100 is the top of the plot, 0 the bottom.
    expect(c!.y).toBe(chart!.plot.top);
    expect(a!.y).toBe(chart!.plot.bottom);
    expect(chart!.line.startsWith("M")).toBe(true);
    expect(chart!.area.endsWith("Z")).toBe(true);
  });

  it("scales a byte series to a round maximum above its largest value", () => {
    const chart = buildChart(series("networkIn", "bytes", [100, 4300, 900]));
    expect(chart!.max).toBe(5000);
    expect(chart!.yTicks.map((t) => t.value)).toEqual([0, 2500, 5000]);
  });

  it("sorts unordered points, drops values that are not finite and repeated times", () => {
    const base = series("cpu", "percent", [10, 20, 30]);
    const shuffled: MetricSeriesView = {
      ...base,
      points: [
        base.points[2]!,
        { at: "not a date", value: 5 },
        base.points[0]!,
        { at: base.points[1]!.at, value: Number.NaN },
        base.points[1]!,
        base.points[1]!,
      ],
    };
    const chart = buildChart(shuffled);
    expect(chart!.dots.map((d) => d.value)).toEqual([10, 20, 30]);
  });

  it("draws one point as a dot with a path that has a length of zero", () => {
    const chart = buildChart(series("cpu", "percent", [42]));
    expect(chart!.dots).toHaveLength(1);
    expect(chart!.line).toMatch(/^M[\d.]+ [\d.]+$/);
  });

  it("returns null when no point is usable (the screen then shows its empty state)", () => {
    expect(buildChart(series("cpu", "percent", []))).toBeNull();
    expect(
      buildChart({ metric: "cpu", unit: "percent", points: [{ at: "x", value: 1 }] }),
    ).toBeNull();
  });

  it("gives x ticks at the first, the middle and the last time", () => {
    const chart = buildChart(series("cpu", "percent", [1, 2, 3, 4, 5]));
    expect(chart!.xTicks).toHaveLength(3);
    expect(chart!.xTicks[0]!.x).toBe(chart!.plot.left);
    expect(chart!.xTicks[2]!.x).toBe(chart!.plot.right);
  });

  it("keeps every coordinate inside the plot (no value can draw outside the chart)", () => {
    const chart = buildChart(series("cpu", "percent", [-50, 250, 100]));
    for (const d of chart!.dots) {
      expect(d.y).toBeGreaterThanOrEqual(chart!.plot.top);
      expect(d.y).toBeLessThanOrEqual(chart!.plot.bottom);
    }
  });
});

describe("statusOf", () => {
  it("is ok when the checks never failed, failed when the latest point is above zero", () => {
    expect(statusOf(series("statusCheckFailed", "count", [0, 0, 0]))).toBe("ok");
    expect(statusOf(series("statusCheckFailed", "count", [0, 1, 0]))).toBe("recovered");
    expect(statusOf(series("statusCheckFailed", "count", [0, 0, 1]))).toBe("failed");
    expect(statusOf(series("statusCheckFailed", "count", []))).toBe("unknown");
  });
});
