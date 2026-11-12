"use client";

import { Button, Field, OptionGroup } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyOption } from "../../../../../server/servers-view.ts";
import { fileNameOfPrivateKey, generateEd25519KeyPair } from "./ssh-keygen.ts";

// The key step of the create wizard (WPU-G10), like the Lightsail console: use a key you have, create a
// key pair here, or upload (paste) your public key. The private key of a pair is made in this tab with
// Web Crypto, handed over as a download ONCE, and then dropped from memory; it is not a form field, is not
// logged and never leaves the browser. Only the public line is posted (R3, R14). The server checks the
// key again (R9) and stores it with the same repository as /settings/ssh-keys.

export type KeyMode = "existing" | "generate" | "paste";
type Phase = "idle" | "working" | "made" | "saved" | "unsupported" | "failed";

export function KeyStep({
  locale,
  keys,
  fieldError,
  nameTaken,
  onReady,
}: {
  locale: Locale;
  keys: KeyOption[];
  /** The text of the error of one field of the form, or undefined. */
  fieldError: (name: string) => string | undefined;
  /** True when the server said the name is already used by another key. */
  nameTaken: boolean;
  /** Tells the form whether this step lets the server be created (the submit button follows). */
  onReady: (ready: boolean) => void;
}) {
  const t = useTranslations("Servers.new");
  const base = useId();
  const [mode, setMode] = useState<KeyMode>(keys.length > 0 ? "existing" : "generate");
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  // The only copy of the private key. A ref, so it is not in any rendered output or state snapshot.
  const privateKey = useRef<string | null>(null);

  // Leaving the page or the mode drops the private key from memory.
  useEffect(() => {
    return () => {
      privateKey.current = null;
    };
  }, []);

  const ready = mode === "existing" ? keys.length > 0 : mode === "paste" ? true : phase === "saved";
  useEffect(() => {
    onReady(ready);
  }, [ready, onReady]);

  const chooseMode = (next: KeyMode): void => {
    setMode(next);
    if (next !== "generate") {
      privateKey.current = null;
      setPhase("idle");
      setPublicKey("");
    }
  };

  const nameOk = /^[A-Za-z0-9 ._-]{1,60}$/.test(name.trim());

  const make = async (): Promise<void> => {
    setPhase("working");
    try {
      const pair = await generateEd25519KeyPair(name.trim());
      privateKey.current = pair.privateKey;
      setPublicKey(pair.publicKey);
      setPhase("made");
    } catch (error) {
      // No detail is kept or shown: the message of a crypto error says nothing a customer can use.
      setPhase(
        error instanceof DOMException && error.name === "NotSupportedError"
          ? "unsupported"
          : "failed",
      );
    }
  };

  const download = (): void => {
    const text = privateKey.current;
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/x-pem-file" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileNameOfPrivateKey(name.trim());
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    // Once: the private key is gone from this page after the download.
    privateKey.current = null;
    setPhase("saved");
  };

  const modes: { id: KeyMode; label: string }[] = [
    ...(keys.length > 0 ? [{ id: "existing" as const, label: t("keyMode.existing") }] : []),
    { id: "generate", label: t("keyMode.generate") },
    { id: "paste", label: t("keyMode.paste") },
  ];
  const nameError = nameTaken ? t("keyNameTaken") : fieldError("newKeyName");

  return (
    <fieldset className="cd-filter-block">
      <legend className="seccolor h6 mb-4">{t("step.key")}</legend>
      <input type="hidden" name="keyMode" value={mode} />
      <ul className="radio-group radios-filter cd-filter-content list">
        {modes.map((m, index) => (
          <li key={m.id}>
            <input
              type="radio"
              id={`${base}-m${index}`}
              name="keyModeChoice"
              value={m.id}
              checked={mode === m.id}
              onChange={() => chooseMode(m.id)}
            />
            <label className="radio-label seccolor" htmlFor={`${base}-m${index}`}>
              {m.label}
            </label>
          </li>
        ))}
      </ul>
      <p className="form-text seccolor">{t("keyRequired")}</p>

      {mode === "existing" ? (
        <>
          <OptionGroup
            kind="select"
            name="keyPairId"
            legend={t("keyMode.existing")}
            options={keys.map((key) => ({ value: key.id, label: key.name }))}
            defaultValue={(keys[0] as KeyOption).id}
            hint={t("keyHint")}
            required
            {...(fieldError("keyPairId") !== undefined
              ? { error: fieldError("keyPairId") as string }
              : {})}
          />
          <p className="seccolor mb-4">
            <a href={localePath(locale, "/settings/ssh-keys")}>{t("keyLink")}</a>
          </p>
        </>
      ) : null}

      {mode === "paste" ? (
        <>
          <Field
            name="newKeyName"
            label={t("keyName")}
            hint={t("keyNameHint")}
            maxLength={60}
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            {...(nameError !== undefined ? { error: nameError } : {})}
          />
          <Field
            name="newKeyPublic"
            label={t("keyPublic")}
            hint={t("keyPublicHint")}
            multiline
            rows={4}
            required
            autoComplete="off"
            spellCheck={false}
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
            {...(fieldError("newKeyPublic") !== undefined
              ? { error: fieldError("newKeyPublic") as string }
              : {})}
          />
        </>
      ) : null}

      {mode === "generate" ? (
        <>
          <Field
            name="newKeyName"
            label={t("keyName")}
            hint={t("keyNameHint")}
            maxLength={60}
            required
            autoComplete="off"
            value={name}
            readOnly={phase === "made" || phase === "saved"}
            onChange={(event) => setName(event.target.value)}
            {...(nameError !== undefined ? { error: nameError } : {})}
          />
          <input type="hidden" name="newKeyPublic" value={publicKey} />
          <div role="status" aria-live="polite">
            {phase === "idle" || phase === "working" ? (
              <Button
                type="button"
                variant="secondary"
                icon="fas fa-key"
                pending={phase === "working"}
                disabled={!nameOk}
                onClick={() => {
                  void make();
                }}
              >
                {t("keyGenerate")}
              </Button>
            ) : null}
            {phase === "made" ? (
              <div className="alert alert-info text-start">
                <i className="fas fa-info-circle me-2" aria-hidden="true" />
                {t("keyMade")}
                <div className="mt-3">
                  <Button type="button" icon="fas fa-download" onClick={download}>
                    {t("keyDownload")}
                  </Button>
                </div>
              </div>
            ) : null}
            {phase === "saved" ? (
              <div className="alert alert-info text-start">
                <i className="fas fa-check-circle me-2" aria-hidden="true" />
                {t("keySaved")}
              </div>
            ) : null}
            {phase === "unsupported" || phase === "failed" ? (
              <div className="alert alert-danger text-start" role="alert">
                <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
                {phase === "unsupported" ? t("keyUnsupported") : t("keyFailed")}
              </div>
            ) : null}
          </div>
          {phase === "idle" ? <p className="form-text seccolor">{t("keyGenerateHint")}</p> : null}
        </>
      ) : null}
    </fieldset>
  );
}
