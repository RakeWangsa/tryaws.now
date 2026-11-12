import type { MetricRangeKey, MetricSeriesView, ReaderPort } from "../extras-view.ts";

// Development and test only. A reader that answers the same four series for every resource, so the
// Metrics tab can be seen without AWS. Reached only through the literal dynamic import in runtime.ts,
// which runs when the configuration says fakes (config.ts refuses that in staging and production).
// It is NOT a tenant check: the page checks the ownership before it asks (loadMetrics).

const WINDOW_MS: Record<MetricRangeKey, { window: number; step: number }> = {
  "1h": { window: 3_600_000, step: 300_000 },
  "1d": { window: 86_400_000, step: 900_000 },
  "1w": { window: 604_800_000, step: 3_600_000 },
};

function wave(i: number, base: number, amplitude: number, phase: number): number {
  return Math.max(0, base + amplitude * Math.sin(i / 3 + phase));
}

export function devReader(now: () => number = Date.now): ReaderPort {
  return {
    async metrics(_resourceId, _caller, range) {
      const { window, step } = WINDOW_MS[range];
      const end = Math.floor(now() / step) * step;
      const count = Math.floor(window / step);
      const times = Array.from({ length: count }, (_, i) =>
        new Date(end - (count - 1 - i) * step).toISOString(),
      );
      const make = (
        metric: MetricSeriesView["metric"],
        unit: MetricSeriesView["unit"],
        value: (i: number) => number,
      ): MetricSeriesView => ({
        metric,
        unit,
        points: times.map((at, i) => ({ at, value: Math.round(value(i) * 10) / 10 })),
      });
      return {
        ok: true,
        series: [
          make("cpu", "percent", (i) => Math.min(100, wave(i, 18, 12, 0))),
          make("networkIn", "bytes", (i) => wave(i, 400_000, 300_000, 1)),
          make("networkOut", "bytes", (i) => wave(i, 900_000, 600_000, 2)),
          make("statusCheckFailed", "count", () => 0),
        ],
      };
    },
  };
}
