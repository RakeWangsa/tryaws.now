import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps {
  as?: "div" | "section" | "article";
  title?: ReactNode;
  titleAs?: "h2" | "h3" | "h4";
  className?: string;
  children?: ReactNode;
}

/** The card of the mockup (checkout.html, login.html): `div.sec-main.sec-bg1.bg-seccolorstyle.noshadow`. */
export function Card({
  as: Root = "div",
  title,
  titleAs: Heading = "h2",
  className,
  children,
}: CardProps) {
  return (
    <Root className={cx("sec-main sec-bg1 bg-seccolorstyle noshadow", className)}>
      {title ? <Heading className="h4 mergecolor mb-3">{title}</Heading> : null}
      {children}
    </Root>
  );
}
