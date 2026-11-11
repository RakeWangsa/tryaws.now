import { useTranslations } from "next-intl";
import { cx } from "./cx";

export interface SkeletonProps {
  /** 1 to 12 lines; default 3. */
  lines?: number;
  className?: string;
}

const WIDTHS = ["col-12", "col-10", "col-8"] as const;

/** A loading placeholder of the theme (`placeholder-glow`). */
export function Skeleton({ lines = 3, className }: SkeletonProps) {
  const t = useTranslations("kit.common");
  if (!Number.isInteger(lines) || lines < 1 || lines > 12) {
    throw new RangeError(`Skeleton: lines must be a whole number from 1 to 12, got ${lines}`);
  }
  return (
    <div className={cx("placeholder-glow", className)} aria-busy="true">
      {Array.from({ length: lines }, (_, index) => (
        <p key={index} className="mb-2">
          <span className={cx("placeholder", WIDTHS[index % WIDTHS.length])} />
        </p>
      ))}
      <span className="visually-hidden">{t("loading")}</span>
    </div>
  );
}
