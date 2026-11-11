import { useTranslations } from "next-intl";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "./cx";

export interface FormBlockProps {
  children?: ReactNode;
  className?: string;
}

/** The form group of the mockup (elements.html, "Form Inputs"): `div.cd-filter-block.mb-0 > div.cd-filter-content`. */
export function FormBlock({ children, className }: FormBlockProps) {
  return (
    <div className={cx("cd-filter-block mb-0", className)}>
      <div className="cd-filter-content">{children}</div>
    </div>
  );
}

/** The three element ids of a field: the control, its hint and its error. */
export function fieldIds(id: string): { input: string; hint: string; error: string } {
  return { input: id, hint: `${id}-hint`, error: `${id}-error` };
}

export interface FieldProps extends Omit<
  ComponentProps<"input">,
  "className" | "id" | "name" | "type"
> {
  name: string;
  label: string;
  id?: string;
  type?: "text" | "email" | "password" | "tel" | "number" | "search" | "url";
  multiline?: boolean;
  rows?: number;
  hint?: string;
  error?: string;
  /** Font Awesome classes of an icon before the label, for example `fas fa-user-tie`. */
  icon?: string;
  optional?: boolean;
  className?: string;
}

/** A labelled text control with an optional hint and error. The error is announced and never shown by color alone. */
export function Field({
  name,
  label,
  id,
  type = "text",
  multiline = false,
  rows,
  hint,
  error,
  icon,
  optional = false,
  className,
  ...rest
}: FieldProps) {
  const t = useTranslations("kit.field");
  const generated = useId();
  const ids = fieldIds(id ?? generated);
  const describedBy = [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean).join(" ");
  const shared = {
    id: ids.input,
    name,
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": error ? (true as const) : undefined,
  };

  return (
    <div className={cx("position-relative mb-3", className)}>
      <label className="seccolor" htmlFor={ids.input}>
        {icon ? <i className={`${icon} me-2`} aria-hidden="true" /> : null}
        {label}
        {optional ? (
          <>
            {" "}
            <span className="c-grey tc-field-optional">{t("optional")}</span>
          </>
        ) : null}
      </label>
      {multiline ? (
        <textarea
          {...(rest as unknown as ComponentProps<"textarea">)}
          {...shared}
          className="form-control"
          rows={rows}
        />
      ) : (
        <input {...rest} {...shared} type={type} />
      )}
      {hint ? (
        <p id={ids.hint} className="form-text seccolor">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.error} className="tc-field-error" role="alert">
          <i className="fas fa-exclamation-circle me-1" aria-hidden="true" />
          <span className="visually-hidden">{t("error")}</span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
