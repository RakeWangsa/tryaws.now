"use client";

import { Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import type { ThreadActionResult } from "./actions.ts";

// The forms of /support/requests/[id] (WPU-Z6): the reply and "Close request". The server checks everything
// again (support-thread-actions.ts). The idempotency key of a reply comes from the server with the render of
// the page (one key per form render, R7): a second click or a retry after a lost answer is the same reply.
// After a reply the page is rendered again with a new key; until it arrives the form waits, so a used key is
// never sent with another text. This file imports nothing from @tc/core.

export type ThreadAction = (input: unknown) => Promise<ThreadActionResult>;

function ErrorAlert({ error }: { error: string }) {
  const t = useTranslations("SupportRequests");
  return (
    <div className="alert alert-danger text-start" role="alert">
      <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
      {t.has(`error.${error}`) ? t(`error.${error}`) : t("error.unavailable")}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="alert alert-info text-start" role="status">
      <i className="fas fa-check-circle me-2" aria-hidden="true" />
      {text}
    </div>
  );
}

export function ReplyForm({
  requestId,
  idempotencyKey,
  closed,
  action,
  initialError = null,
}: {
  requestId: string;
  /** Made on the server for this render of the form. */
  idempotencyKey: string;
  /** The request is closed: the form says that a reply opens it again. */
  closed: boolean;
  action: ThreadAction;
  /** Only for the tests of the error state. */
  initialError?: string | null;
}) {
  const t = useTranslations("SupportRequests");
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The key of the last reply that went through; the form waits until the page brings a new one.
  const [usedKey, setUsedKey] = useState<string | null>(null);
  const waiting = usedKey === idempotencyKey;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || waiting) return;
    // The key is the hidden field the server rendered with this form.
    const key = String(new FormData(event.currentTarget).get("idempotencyKey") ?? "");
    setError(null);
    setInvalid(false);
    setNotice(null);
    setPending(true);
    try {
      const result = await action({ requestId, idempotencyKey: key, body: text });
      if (result.ok) {
        setUsedKey(key);
        setText("");
        setNotice(result.replayed ? t("reply.replayed") : t("reply.done"));
        router.refresh();
      } else {
        setError(result.error);
        if ("fields" in result && result.fields?.["body"] !== undefined) setInvalid(true);
      }
    } catch {
      setError("unavailable");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {closed ? (
        <div className="alert alert-warning text-start" role="note">
          <i className="fas fa-lock me-2" aria-hidden="true" />
          {t("thread.closed")}
        </div>
      ) : null}
      {error !== null ? <ErrorAlert error={error} /> : null}
      {notice !== null ? <Notice text={notice} /> : null}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field
        name="body"
        label={t("reply.label")}
        hint={t("reply.hint")}
        multiline
        rows={6}
        required
        maxLength={5000}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        {...(invalid ? { error: t("field.invalid") } : {})}
      />
      <p className="seccolor small">
        <i className="fas fa-info-circle me-2" aria-hidden="true" />
        {t("reply.rule")}
      </p>
      <SubmitButton variant="primary" pending={pending} disabled={pending || waiting}>
        {pending ? t("reply.working") : t("reply.submit")}
      </SubmitButton>
    </form>
  );
}

export function CloseRequestForm({
  requestId,
  action,
}: {
  requestId: string;
  action: ThreadAction;
}) {
  const t = useTranslations("SupportRequests");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await action({ requestId });
      if (result.ok) {
        setDone(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError("unavailable");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit}>
      {error !== null ? <ErrorAlert error={error} /> : null}
      {done ? <Notice text={t("close.done")} /> : null}
      <p className="seccolor small">{t("close.hint")}</p>
      <SubmitButton variant="default" icon="fas fa-lock" pending={pending} disabled={pending}>
        {pending ? t("close.working") : t("close.button")}
      </SubmitButton>
    </form>
  );
}
