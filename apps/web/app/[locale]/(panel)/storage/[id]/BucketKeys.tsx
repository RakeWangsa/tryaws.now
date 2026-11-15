"use client";

import { Button, CopyField, Field, SecretReveal } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FreshSignInLink } from "../../_family/FreshSignInLink.tsx";

// The key part of the Keys tab (16.10, U9). Client Component: it holds the secret key in memory for
// the 60 seconds of the window and drops it when SecretReveal says the window ended. The secret is not
// in the server HTML, in an attribute, in storage or in a log. The action is the Server Action
// `createBucketKeyAction`; a test passes a fake.

export type KeyResult =
  { ok: true; accessKeyId: string; secretAccessKey: string } | { ok: false; error: string };

export function BucketKeys({
  bucketId,
  requestId,
  active,
  action,
  initial = null,
}: {
  bucketId: string;
  /** One id for this page view (R7): a second click of the same view is the same request. */
  requestId: string;
  /** False when the bucket is not on: the button is not offered. */
  active: boolean;
  action: (form: FormData) => Promise<KeyResult>;
  /** Tests only: a state that is normally reached by the button. */
  initial?: { accessKeyId: string; secretAccessKey: string } | null;
}) {
  const t = useTranslations("Storage.detail.keys");
  const [secret, setSecret] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [gone, setGone] = useState(false);
  // One id per attempt (R7): it stays while the secret is on screen, and a new one is made when the
  // secret is hidden or the attempt failed, so a deliberate second key is not taken for a double click.
  const [rid, setRid] = useState(requestId);
  const freshId = () => setRid(globalThis.crypto.randomUUID());

  async function create(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await action(form);
      if (result.ok) {
        setSecret({ accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey });
        setGone(false);
      } else {
        setError(result.error);
        // A failed attempt may be tried again; a repeat of a made key must not be (already_created).
        if (result.error !== "already_created") freshId();
      }
    } catch {
      setError("unavailable");
    } finally {
      setPending(false);
    }
  }

  const te = useTranslations("Storage.error");
  return (
    <div>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <div className="alert alert-warning text-start" role="note">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t("warning")}
      </div>
      {error !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {te.has(error) ? te(error) : te("unavailable")}
          <FreshSignInLink error={error ?? undefined} />
        </div>
      ) : null}
      {secret !== null ? (
        <>
          <CopyField label={t("keyId")} value={secret.accessKeyId} />
          <SecretReveal
            label={t("secret")}
            secret={secret.secretAccessKey}
            onHidden={() => {
              setSecret(null);
              setGone(true);
              freshId();
            }}
          />
        </>
      ) : !active ? (
        <p className="seccolor">{t("notReady")}</p>
      ) : (
        <form action={create}>
          <input type="hidden" name="bucketId" value={bucketId} />
          <input type="hidden" name="requestId" value={rid} />
          <Field
            name="confirmName"
            label={t("confirmLabel")}
            hint={t("confirmHint")}
            maxLength={120}
            autoComplete="off"
          />
          {gone ? <p className="seccolor">{t("gone")}</p> : null}
          <Button type="submit" variant="primary" icon="fas fa-key" pending={pending}>
            {pending ? t("working") : t("create")}
          </Button>
        </form>
      )}
    </div>
  );
}
