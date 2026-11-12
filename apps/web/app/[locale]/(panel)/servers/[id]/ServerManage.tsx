"use client";

import { CopyField, DataTable, EmptyState, Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import { ActionNotice } from "./ExtrasForms.tsx";
import type { ExtrasAction } from "./ExtrasForms.tsx";

// The header buttons and the Networking tab forms of /servers/[id] (WPU-G2). U8: every form posts to
// a Server Action that follows R9, shows its field errors from the server's own check and is inert
// while it runs. U11: the empty, error and flag-off states are here; nothing is shown by color alone.
// Each form carries the request id that the page made (R7). This file never imports AWS (R1) and
// shows no AWS name (U6).

export interface ManageActions {
  reboot: ExtrasAction;
  stop: ExtrasAction;
  start: ExtrasAction;
  rename: ExtrasAction;
  addRule: ExtrasAction;
  removeRule: ExtrasAction;
  attachIp: ExtrasAction;
  detachIp: ExtrasAction;
}

export interface RuleView {
  protocol: "tcp" | "udp" | "icmp";
  fromPort: number;
  toPort: number;
  cidrs: readonly string[];
}

const ruleKey = (r: RuleView): string => `${r.protocol}:${r.fromPort}-${r.toPort}`;

type Preset = "ssh" | "http" | "https" | "rdp" | "ping" | "custom";

function presetOf(r: RuleView): Preset {
  if (r.protocol === "icmp") return r.fromPort === 8 && r.toPort === -1 ? "ping" : "custom";
  if (r.protocol !== "tcp" || r.fromPort !== r.toPort) return "custom";
  if (r.fromPort === 22) return "ssh";
  if (r.fromPort === 80) return "http";
  if (r.fromPort === 443) return "https";
  if (r.fromPort === 3389) return "rdp";
  return "custom";
}

interface Ids {
  serverId: string;
  requestId: string;
}

function Hidden({ serverId, requestId }: Ids) {
  return (
    <>
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="requestId" value={requestId} />
    </>
  );
}

/** Reboot, stop and start in the header (16.10 Overview). Only the buttons that fit the state show. */
export function PowerBar({
  actions,
  ids,
  state,
  busy,
}: {
  actions: Pick<ManageActions, "reboot" | "stop" | "start">;
  ids: Ids;
  state: string;
  busy: boolean;
}) {
  const t = useTranslations("Servers.detail.manage.power");
  const [reboot, rebootAction] = useActionState(actions.reboot, INITIAL_FORM_STATE);
  const [stop, stopAction] = useActionState(actions.stop, INITIAL_FORM_STATE);
  const [start, startAction] = useActionState(actions.start, INITIAL_FORM_STATE);
  const running = state === "active";
  const stopped = state === "stopped";
  if (!running && !stopped) return null;
  return (
    <div className="mt-3">
      <div className="d-flex flex-wrap gap-2" role="group" aria-label={t("label")}>
        {running ? (
          <>
            <form action={rebootAction}>
              <Hidden {...ids} />
              <SubmitButton variant="default" size="sm" icon="fas fa-redo" disabled={busy}>
                {t("reboot")}
              </SubmitButton>
            </form>
            <form action={stopAction}>
              <Hidden {...ids} />
              <SubmitButton variant="tertiary" size="sm" icon="fas fa-stop" disabled={busy}>
                {t("stop")}
              </SubmitButton>
            </form>
          </>
        ) : (
          <form action={startAction}>
            <Hidden {...ids} />
            <SubmitButton variant="primary" size="sm" icon="fas fa-play" disabled={busy}>
              {t("start")}
            </SubmitButton>
          </form>
        )}
      </div>
      {running ? <p className="seccolor small mt-2 mb-0">{t("stopNote")}</p> : null}
      <div className="mt-2">
        <ActionNotice state={reboot} />
        <ActionNotice state={stop} />
        <ActionNotice state={start} />
      </div>
    </div>
  );
}

/** Rename (16.10 Overview). The name is the customer's own label; the same rule as the create form. */
export function RenameForm({
  action,
  ids,
  current,
  disabled,
}: {
  action: ExtrasAction;
  ids: Ids;
  current: string;
  disabled: boolean;
}) {
  const t = useTranslations("Servers.detail.manage.rename");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <ActionNotice state={state} />
      <Hidden {...ids} />
      <Field
        name="displayName"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        defaultValue={current}
        disabled={disabled}
        {...(state.fields?.["displayName"] !== undefined ? { error: tf("field.invalid") } : {})}
      />
      <SubmitButton variant="primary" disabled={disabled}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

function RemoveRuleForm({
  action,
  ids,
  rule,
  disabled,
}: {
  action: ExtrasAction;
  ids: Ids;
  rule: RuleView;
  disabled: boolean;
}) {
  const t = useTranslations("Servers.detail.manage.firewall");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction}>
      <Hidden {...ids} />
      <input type="hidden" name="ruleKey" value={ruleKey(rule)} />
      <SubmitButton variant="destructive" size="sm" icon="fas fa-trash" disabled={disabled}>
        {t("remove")}
      </SubmitButton>
      <ActionNotice state={state} />
    </form>
  );
}

function AddRuleForm({
  action,
  ids,
  windows,
  disabled,
}: {
  action: ExtrasAction;
  ids: Ids;
  windows: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("Servers.detail.manage.firewall");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [preset, setPreset] = useState<Preset>("https");
  const [protocol, setProtocol] = useState("tcp");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"any" | "restrict">("any");
  const presets: Preset[] = windows
    ? ["rdp", "http", "https", "ping", "ssh", "custom"]
    : ["ssh", "http", "https", "ping", "custom"];
  const first = Number(from);
  const last = to === "" ? first : Number(to);
  const coversSsh =
    preset === "ssh" ||
    (preset === "custom" &&
      protocol === "tcp" &&
      /^\d+$/.test(from) &&
      /^\d*$/.test(to) &&
      first <= 22 &&
      last >= 22);
  const fieldError = (name: string): { error: string } | Record<string, never> => {
    const code = state.fields?.[name];
    if (code === undefined) return {};
    return {
      error: t.has(`fieldError.${code}`) ? t(`fieldError.${code}`) : t("fieldError.invalid"),
    };
  };
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("addTitle")}</h3>
      <ActionNotice state={state} />
      <Hidden {...ids} />
      <div className="mb-3">
        <label className="form-label" htmlFor="rule-preset">
          {t("preset")}
        </label>
        <select
          className="form-select"
          id="rule-preset"
          name="preset"
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
          disabled={disabled}
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {t(`presets.${p}`)}
            </option>
          ))}
        </select>
      </div>
      {preset === "custom" ? (
        <>
          <div className="mb-3">
            <label className="form-label" htmlFor="rule-protocol">
              {t("protocolField")}
            </label>
            <select
              className="form-select"
              id="rule-protocol"
              name="protocol"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              disabled={disabled}
            >
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </div>
          <div className="row g-3">
            <div className="col-12 col-md-6">
              <Field
                name="fromPort"
                label={t("fromPort")}
                inputMode="numeric"
                maxLength={5}
                autoComplete="off"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={disabled}
                {...fieldError("fromPort")}
              />
            </div>
            <div className="col-12 col-md-6">
              <Field
                name="toPort"
                label={t("toPort")}
                inputMode="numeric"
                maxLength={5}
                autoComplete="off"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={disabled}
                {...fieldError("toPort")}
              />
            </div>
          </div>
        </>
      ) : null}
      <fieldset className="mb-3">
        <legend className="seccolor fs-6">{t("sourceMode")}</legend>
        <div className="form-check">
          <input
            className="form-check-input"
            type="radio"
            id="rule-source-any"
            name="sourceMode"
            value="any"
            checked={mode === "any"}
            onChange={() => setMode("any")}
            disabled={disabled}
          />
          <label className="form-check-label" htmlFor="rule-source-any">
            {t("sourceAny")}
          </label>
        </div>
        <div className="form-check">
          <input
            className="form-check-input"
            type="radio"
            id="rule-source-restrict"
            name="sourceMode"
            value="restrict"
            checked={mode === "restrict"}
            onChange={() => setMode("restrict")}
            disabled={disabled}
          />
          <label className="form-check-label" htmlFor="rule-source-restrict">
            {t("sourceRestrict")}
          </label>
        </div>
      </fieldset>
      {mode === "restrict" ? (
        <Field
          name="sources"
          label={t("sources")}
          hint={t("sourcesHint")}
          multiline
          rows={3}
          autoComplete="off"
          disabled={disabled}
          {...fieldError("sources")}
        />
      ) : null}
      {coversSsh && mode === "any" ? (
        <div className="alert alert-warning text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t("sshWarning")}
        </div>
      ) : null}
      <SubmitButton variant="primary" disabled={disabled}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

/** The firewall rules of the server: a table, add and remove (16.10 Networking, spec `saveFirewallRules`). */
export function FirewallEditor({
  rules,
  sshOpenToWorld,
  actions,
  ids,
  windows,
  disabled,
}: {
  /** null when the saved list cannot be read: nothing is shown or edited then (R16). */
  rules: RuleView[] | null;
  sshOpenToWorld: boolean;
  actions: Pick<ManageActions, "addRule" | "removeRule">;
  ids: Ids;
  windows: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("Servers.detail.manage.firewall");
  if (rules === null) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t("unreadable")}
      </div>
    );
  }
  const portsOf = (r: RuleView): string =>
    r.protocol === "icmp"
      ? `${r.fromPort} / ${r.toPort}`
      : r.fromPort === r.toPort
        ? String(r.fromPort)
        : `${r.fromPort} - ${r.toPort}`;
  return (
    <>
      {sshOpenToWorld ? (
        <div className="alert alert-warning text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t("sshWarning")}
        </div>
      ) : null}
      {rules.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        <DataTable
          caption={t("caption")}
          rows={rules}
          rowKey={ruleKey}
          columns={[
            { key: "app", header: t("application"), cell: (r) => t(`presets.${presetOf(r)}`) },
            { key: "protocol", header: t("protocol"), cell: (r) => r.protocol.toUpperCase() },
            { key: "ports", header: t("ports"), cell: portsOf },
            {
              key: "source",
              header: t("source"),
              cell: (r) => (r.cidrs.includes("0.0.0.0/0") ? t("anyIpv4") : r.cidrs.join(", ")),
            },
            {
              key: "action",
              header: t("action"),
              cell: (r) => (
                <RemoveRuleForm
                  action={actions.removeRule}
                  ids={ids}
                  rule={r}
                  disabled={disabled}
                />
              ),
            },
          ]}
        />
      )}
      <div className="mt-4">
        <AddRuleForm action={actions.addRule} ids={ids} windows={windows} disabled={disabled} />
      </div>
    </>
  );
}

/** Attach or detach the server's static IP (16.10 Networking, spec `attachStaticIp` and `detachStaticIp`). */
export function StaticIpPanel({
  attached,
  address,
  actions,
  ids,
  disabled,
}: {
  attached: boolean;
  address: string | null;
  actions: Pick<ManageActions, "attachIp" | "detachIp">;
  ids: Ids;
  disabled: boolean;
}) {
  const t = useTranslations("Servers.detail.manage.staticIp");
  const [attach, attachAction] = useActionState(actions.attachIp, INITIAL_FORM_STATE);
  const [detach, detachAction] = useActionState(actions.detachIp, INITIAL_FORM_STATE);
  return (
    <>
      <p className="seccolor">{attached ? t("attached") : t("detached")}</p>
      {address === null ? null : <CopyField label={t("address")} value={address} />}
      {attached ? (
        <form action={detachAction} noValidate className="mt-3">
          <Hidden {...ids} />
          <ActionNotice state={detach} />
          <p className="seccolor">{t("detachWarn")}</p>
          <div className="form-check mb-3">
            <input
              className="form-check-input"
              type="checkbox"
              id="static-ip-ack"
              name="acknowledge"
              disabled={disabled}
              aria-invalid={detach.fields?.["acknowledge"] !== undefined ? true : undefined}
            />
            <label className="form-check-label" htmlFor="static-ip-ack">
              {t("acknowledge")}
            </label>
          </div>
          <SubmitButton variant="destructive" size="sm" disabled={disabled}>
            {t("detach")}
          </SubmitButton>
        </form>
      ) : (
        <form action={attachAction} className="mt-3">
          <Hidden {...ids} />
          <ActionNotice state={attach} />
          <SubmitButton variant="primary" size="sm" disabled={disabled}>
            {t("attach")}
          </SubmitButton>
        </form>
      )}
    </>
  );
}
