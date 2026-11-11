import { useTranslations } from "next-intl";
import { useId } from "react";
import { fieldIds } from "./Field";

export interface OptionItem {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface OptionGroupProps {
  kind: "radio" | "checkbox" | "select";
  name: string;
  legend: string;
  options: OptionItem[];
  defaultValue?: string | string[];
  hint?: string;
  error?: string;
  required?: boolean;
}

/**
 * A group of native choices (configurator.html): radios, checkboxes or a select. It keeps no state;
 * the form owns the values.
 */
export function OptionGroup({
  kind,
  name,
  legend,
  options,
  defaultValue,
  hint,
  error,
  required = false,
}: OptionGroupProps) {
  const t = useTranslations("kit.field");
  const base = useId();
  const ids = fieldIds(base);

  const minimum = kind === "radio" ? 2 : kind === "select" ? 1 : 0;
  if (options.length < minimum) {
    throw new RangeError(`OptionGroup ${name}: a ${kind} needs at least ${minimum} option(s)`);
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.value)) {
      throw new RangeError(`OptionGroup ${name}: duplicate option value ${option.value}`);
    }
    seen.add(option.value);
  }

  const describedBy = [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean).join(" ");
  const aria = {
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": error ? (true as const) : undefined,
  };
  const note = (
    <>
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
    </>
  );

  if (kind === "select") {
    const chosen = typeof defaultValue === "string" ? defaultValue : undefined;
    return (
      <div className="cd-filter-block">
        <label className="seccolor h6 mb-3 d-block" htmlFor={ids.input}>
          {legend}
        </label>
        <div className="cd-select">
          <select
            id={ids.input}
            name={name}
            className="select-filter"
            defaultValue={chosen}
            required={required}
            {...aria}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {note}
      </div>
    );
  }

  const checked = new Set(Array.isArray(defaultValue) ? defaultValue : [defaultValue]);
  const isRadio = kind === "radio";
  return (
    <div className="cd-filter-block">
      <fieldset aria-required={!isRadio && required ? true : undefined} {...aria}>
        <legend className="seccolor h6 mb-4">{legend}</legend>
        <ul
          className={
            isRadio ? "radio-group radios-filter cd-filter-content list" : "cd-filter-content list"
          }
        >
          {options.map((option, i) => {
            const id = `${base}-${i}`;
            return (
              <li key={option.value}>
                <input
                  type={kind}
                  id={id}
                  name={name}
                  value={option.value}
                  defaultChecked={checked.has(option.value)}
                  disabled={option.disabled}
                  required={isRadio && required ? true : undefined}
                />
                <label
                  className={isRadio ? "radio-label seccolor" : "checkbox-label seccolor"}
                  htmlFor={id}
                >
                  {option.label}
                </label>
                {option.hint ? <small className="d-block seccolor">{option.hint}</small> : null}
              </li>
            );
          })}
        </ul>
        {note}
      </fieldset>
    </div>
  );
}
