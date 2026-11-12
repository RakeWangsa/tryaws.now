import type { MetricSeriesView } from "./extras-view.ts";

// WPU-G4: the geometry of the charts of the Metrics tab. Pure: the same series gives the same
// numbers, and no value can leave the plot. The renderer (ExtrasTabs.tsx) draws them as inline SVG,
// with classes only and no script (U2, U3, U4). Display numbers are not money, so floating point is
// fine here (R4 is about amounts of money).

export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 220;
const PLOT = Object.freeze({ left: 56, top: 12, right: 628, bottom: 180 });

export interface ChartDot {
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly at: string;
}

export interface Chart {
  readonly width: number;
  readonly height: number;
  readonly plot: typeof PLOT;
  /** The top of the y axis, in the unit of the series (bytes stay bytes). */
  readonly max: number;
  readonly yTicks: readonly { readonly y: number; readonly value: number }[];
  readonly xTicks: readonly { readonly x: number; readonly at: string }[];
  readonly dots: readonly ChartDot[];
  /** SVG path data of the line. */
  readonly line: string;
  /** SVG path data of the area under the line, closed on the axis. */
  readonly area: string;
  readonly last: number;
}

/** 1, 2 or 5 times a power of ten that is not below `value`; at least 1. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}

export type ByteUnit = "B" | "KB" | "MB" | "GB";

export function bytesScale(max: number): { unit: ByteUnit; divisor: number } {
  if (!Number.isFinite(max) || max < 1024) return { unit: "B", divisor: 1 };
  if (max < 1024 ** 2) return { unit: "KB", divisor: 1024 };
  if (max < 1024 ** 3) return { unit: "MB", divisor: 1024 ** 2 };
  return { unit: "GB", divisor: 1024 ** 3 };
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** The usable points: a real time, a finite value, one point for each time, oldest first. */
function usable(series: MetricSeriesView): { at: string; ms: number; value: number }[] {
  const seen = new Set<number>();
  const out: { at: string; ms: number; value: number }[] = [];
  for (const point of series.points) {
    const ms = Date.parse(point.at);
    if (Number.isNaN(ms) || !Number.isFinite(point.value) || seen.has(ms)) continue;
    seen.add(ms);
    out.push({ at: new Date(ms).toISOString(), ms, value: point.value });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export function buildChart(series: MetricSeriesView): Chart | null {
  const points = usable(series);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;

  const highest = Math.max(...points.map((p) => p.value), 0);
  const max = series.unit === "percent" && highest <= 100 ? 100 : niceMax(highest);
  const width = PLOT.right - PLOT.left;
  const height = PLOT.bottom - PLOT.top;
  const span = last.ms - first.ms;
  const xOf = (ms: number): number =>
    span === 0 ? PLOT.left + width / 2 : round(PLOT.left + ((ms - first.ms) / span) * width);
  const yOf = (value: number): number => {
    const clamped = Math.min(Math.max(value, 0), max);
    return round(PLOT.bottom - (clamped / max) * height);
  };

  const dots = points.map((p) => ({ x: xOf(p.ms), y: yOf(p.value), value: p.value, at: p.at }));
  const line = dots.map((d, i) => `${i === 0 ? "M" : "L"}${d.x} ${d.y}`).join(" ");
  const head = dots[0] as ChartDot;
  const tail = dots[dots.length - 1] as ChartDot;
  const area = `${line} L${tail.x} ${PLOT.bottom} L${head.x} ${PLOT.bottom} Z`;

  const midAt = span === 0 ? first.at : new Date(first.ms + span / 2).toISOString();
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    plot: PLOT,
    max,
    yTicks: [0, max / 2, max].map((value) => ({ y: yOf(value), value })),
    xTicks: [
      { x: PLOT.left, at: first.at },
      { x: round(PLOT.left + width / 2), at: midAt },
      { x: PLOT.right, at: last.at },
    ],
    dots,
    line,
    area,
    last: last.value,
  };
}

/** The word under the status check chart: never colour alone (U11). */
export function statusOf(series: MetricSeriesView): "ok" | "recovered" | "failed" | "unknown" {
  const points = usable(series);
  const latest = points[points.length - 1];
  if (latest === undefined) return "unknown";
  if (latest.value > 0) return "failed";
  return points.some((p) => p.value > 0) ? "recovered" : "ok";
}
