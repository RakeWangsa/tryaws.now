import { useLocale } from "next-intl";
import { formatDate, toDate } from "./format";
import { toLocale, type Numerals } from "./types";

export interface DateTextProps {
  /** A Date, or an ISO string with Z or an offset. */
  value: Date | string;
  variant?: "date" | "datetime" | "time";
  numerals?: Numerals;
  className?: string;
}

/** The only place that formats dates; always Asia/Dhaka time (16.13). */
export function DateText({ value, variant, numerals, className }: DateTextProps) {
  const locale = toLocale(useLocale());
  const iso = toDate(value).toISOString();
  return (
    <time dateTime={iso} className={className}>
      {formatDate(value, { locale, variant, numerals })}
    </time>
  );
}
