"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Button } from "./Button";
import { fieldIds } from "./Field";
import { useCopy } from "./use-copy";

export interface CopyFieldProps {
  label: string;
  value: string;
  id?: string;
  hint?: string;
}

/** A read-only value with a copy button, for values that are not secret (an IP address, an endpoint). */
export function CopyField({ label, value, id, hint }: CopyFieldProps) {
  const t = useTranslations("kit.copy");
  const generated = useId();
  const ids = fieldIds(id ?? generated);
  const { status, copy } = useCopy();

  return (
    <div className="position-relative mb-3">
      <label className="seccolor" htmlFor={ids.input}>
        {label}
      </label>
      <div className="tc-copy-row">
        <input
          id={ids.input}
          type="text"
          readOnly
          value={value}
          aria-describedby={hint ? ids.hint : undefined}
        />
        <Button
          size="sm"
          variant="tertiary"
          className="tc-nowrap"
          icon="fas fa-copy"
          onClick={() => {
            void copy(value);
          }}
        >
          {t("copy")}
        </Button>
      </div>
      {hint ? (
        <p id={ids.hint} className="form-text seccolor">
          {hint}
        </p>
      ) : null}
      <p role="status" className="form-text seccolor">
        {status === "copied" ? t("copied") : status === "failed" ? t("failed") : ""}
      </p>
    </div>
  );
}
