"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";
import { useCopy } from "./use-copy";

export interface SecretRevealProps {
  label: string;
  secret: string;
  /** Milliseconds after the first Show at which the secret is removed for good. Default 60000 (U9). */
  hideAfterMs?: number;
  /** Called once, when the window has ended. */
  onHidden?: () => void;
}

type RevealState = "hidden" | "shown" | "expired";

/** A fixed mask: its length never depends on the secret. */
const MASK = "••••••••••••";

/**
 * Shows a secret on request and removes it after a fixed window (rule U9). The secret is not in the
 * server HTML (hidden is the first state), in no attribute, not in web storage and not in a log.
 */
export function SecretReveal({ label, secret, hideAfterMs = 60_000, onHidden }: SecretRevealProps) {
  const t = useTranslations("kit");
  const labelId = useId();
  const [state, setState] = useState<RevealState>("hidden");
  const { status, copy } = useCopy();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(false);
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const toggle = useCallback((): void => {
    if (!started.current) {
      started.current = true;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setState("expired");
        onHiddenRef.current?.();
      }, hideAfterMs);
      setState("shown");
      return;
    }
    setState((current) =>
      current === "shown" ? "hidden" : current === "hidden" ? "shown" : current,
    );
  }, [hideAfterMs]);

  const expired = state === "expired";
  const message = expired
    ? t("secret.expired")
    : status === "copied"
      ? t("copy.copied")
      : status === "failed"
        ? t("copy.failed")
        : "";

  return (
    <div className="tc-secret">
      <span id={labelId} className="seccolor">
        {label}
      </span>
      <output aria-labelledby={labelId} aria-live="off" className="tc-secret-output">
        {state === "shown" ? <code className="tc-secret-value">{secret}</code> : MASK}
      </output>
      <div className="tc-secret-actions">
        <Button
          size="sm"
          variant="tertiary"
          icon={state === "shown" ? "fas fa-eye-slash" : "fas fa-eye"}
          disabled={expired}
          onClick={toggle}
        >
          {state === "shown" ? t("secret.hide") : t("secret.show")}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          icon="fas fa-copy"
          disabled={expired}
          onClick={() => {
            void copy(secret);
          }}
        >
          {t("copy.copy")}
        </Button>
      </div>
      <p role="status" className="form-text seccolor">
        {message}
      </p>
    </div>
  );
}
