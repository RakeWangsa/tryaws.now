"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SubmitButton } from "@tc/ui";

/** Whole seconds left until `resendAt` (epoch seconds), or 0 when it has passed or is unknown. */
export function secondsLeft(nowSeconds: number, resendAt: number | null): number {
  if (resendAt === null || !Number.isFinite(resendAt)) return 0;
  return Math.max(0, Math.ceil(resendAt - nowSeconds));
}

/**
 * The "send again" button with the resend timer of 16.9. Without JavaScript, and before the page
 * has hydrated, the button is enabled and the server limiter decides (the plan's rule); with
 * JavaScript it is inert until `resendAt` and counts down. It must sit inside the resend form.
 */
export function ResendTimer({
  resendAt,
  label,
}: {
  /** Epoch seconds from the server. */
  resendAt: number | null;
  label: string;
}) {
  const t = useTranslations("Auth.verify");
  const [left, setLeft] = useState(0);

  useEffect(() => {
    const tick = (): void => setLeft(secondsLeft(Date.now() / 1000, resendAt));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);

  return (
    <div className="mb-3">
      <SubmitButton variant="tertiary" disabled={left > 0}>
        {label}
      </SubmitButton>
      {left > 0 ? (
        <p className="form-text seccolor" role="status">
          {t("resendWait", { seconds: left })}
        </p>
      ) : null}
    </div>
  );
}
