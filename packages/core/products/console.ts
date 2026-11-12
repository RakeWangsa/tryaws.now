// Pure input rules of the console actions of the customer panel (WPU-G7). Customer text is checked
// here and travels as a value of an AWS request, never as an AWS name or tag key (R11).

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~\-/]{0,99}$/;
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** A plain DNS name: lower case, two labels at least, no wildcard, at most 253 characters. */
export function checkedDomainName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  if (domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  return domain;
}

/** The health check path of a load balancer: a slash first, no query, at most 100 characters. */
export function checkedHealthPath(value: unknown): string | null {
  return typeof value === "string" && HEALTH_PATH.test(value) ? value : null;
}

/** `hh24:mi-hh24:mi` in UTC, at least 30 minutes long (it may cross midnight). */
export function checkedBackupWindow(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = WINDOW.exec(value);
  if (m === null) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const length = (end - start + 1440) % 1440;
  return length >= 30 ? value : null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MAINTENANCE =
  /^(sun|mon|tue|wed|thu|fri|sat):([01]\d|2[0-3]):([0-5]\d)-(sun|mon|tue|wed|thu|fri|sat):([01]\d|2[0-3]):([0-5]\d)$/;
const WEEK = 7 * 1440;

/** Start and length in minutes from Sunday 00:00 UTC, or null. */
function weekly(value: string): { start: number; length: number } | null {
  const m = MAINTENANCE.exec(value);
  if (m === null) return null;
  const at = (day: string, h: string, min: string): number =>
    DAYS.indexOf(day as (typeof DAYS)[number]) * 1440 + Number(h) * 60 + Number(min);
  const start = at(m[1]!, m[2]!, m[3]!);
  const end = at(m[4]!, m[5]!, m[6]!);
  return { start, length: (end - start + WEEK) % WEEK };
}

/** `ddd:hh24:mi-ddd:hh24:mi` in UTC, at least 30 minutes long (it may cross midnight or the week). */
export function checkedMaintenanceWindow(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const w = weekly(value);
  return w !== null && w.length >= 30 ? value : null;
}

/** Whether a daily backup window (`hh:mm-hh:mm`) and a weekly maintenance window share a minute. */
export function windowsOverlap(backup: string, maintenance: string): boolean {
  const b = WINDOW.exec(backup);
  const w = weekly(maintenance);
  if (b === null || w === null) return true; // cannot be compared: treat as overlap (R16)
  const bStart = Number(b[1]) * 60 + Number(b[2]);
  const bLength = (Number(b[3]) * 60 + Number(b[4]) - bStart + 1440) % 1440;
  for (let day = 0; day < 7; day += 1) {
    const s = day * 1440 + bStart;
    // Circular overlap of two intervals in a week.
    if ((w.start - s + WEEK) % WEEK < bLength || (s - w.start + WEEK) % WEEK < w.length)
      return true;
  }
  return false;
}
