"use client";

import { Button, CopyField, SecretReveal } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

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
      <p className="seccolor">{t("listUnavailable")}</p>
      {error !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {te.has(error) ? te(error) : te("unavailable")}
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
            }}
          />
        </>
      ) : !active ? (
        <p className="seccolor">{t("notReady")}</p>
      ) : (
        <form action={create}>
          <input type="hidden" name="bucketId" value={bucketId} />
          <input type="hidden" name="requestId" value={requestId} />
          {gone ? <p className="seccolor">{t("gone")}</p> : null}
          <Button type="submit" variant="primary" icon="fas fa-key" pending={pending}>
            {pending ? t("working") : t("create")}
          </Button>
        </form>
      )}
    </div>
  );
}
