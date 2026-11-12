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
