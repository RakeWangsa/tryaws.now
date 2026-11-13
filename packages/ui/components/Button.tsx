import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import type { LinkComponent } from "./types";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "destructive" | "default";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-default-yellow-fill",
  secondary: "btn-default-pink-fill tc-btn-pink",
  tertiary: "btn-default-pink",
  destructive: "btn-danger tc-btn-danger",
  default: "btn-default-fill",
};

export interface ButtonProps extends Omit<ComponentProps<"button">, "className" | "children"> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** True while a state-changing action runs: the control is inert and says so (U8). */
  pending?: boolean;
  /** With `href` the control is an anchor (or `as`) and looks like a button. */
  href?: string;
  as?: LinkComponent;
  /** A Font Awesome class string, such as `fas fa-plus`. */
  icon?: string;
  className?: string;
  children?: ReactNode;
}

/** Button of the theme (16.4): yellow primary, pink secondary, outline tertiary, red destructive. */
export function Button({
  variant = "primary",
  size = "md",
  pending = false,
  href,
  as,
  icon,
  className,
  children,
  type,
  disabled,
  ...rest
}: ButtonProps) {
  const t = useTranslations("kit.button");
  const inert = pending || disabled === true;
  const classes = cx(
    "btn",
    VARIANT_CLASS[variant],
    size === "sm" && "btn-sm",
    href !== undefined && inert && "disabled",
    className,
  );
  const content = (
    <>
      {pending && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
      {pending && <span className="visually-hidden">{t("pending")}</span>}
      {icon !== undefined && <i className={cx(icon, "me-2")} aria-hidden="true" />}
      {children}
    </>
  );

  if (href !== undefined) {
    const Link = as;
    const anchorProps = {
      href,
      className: classes,
      ...(inert ? { "aria-disabled": true as const, tabIndex: -1 } : {}),
      ...(rest["aria-label"] !== undefined ? { "aria-label": rest["aria-label"] } : {}),
    };
    if (Link) return <Link {...anchorProps}>{content}</Link>;
    return <a {...anchorProps}>{content}</a>;
  }

  return (
    <button
      {...rest}
      type={type ?? "button"}
      className={classes}
      disabled={inert}
      aria-busy={pending ? "true" : undefined}
    >
      {content}
    </button>
  );
}
