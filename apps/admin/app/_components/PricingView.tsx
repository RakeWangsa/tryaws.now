import { useTranslations } from "next-intl";
import {
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  FormBlock,
  MoneyText,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import { FEATURE_FLAGS, FX_SECOND_ADMIN_PERCENT } from "@tc/core";
import type { PreviewRow } from "@tc/core";
import type { AdminActor, FxChange, FxRateRow, PricingRuleRow } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { MAX_DRAFT_STEPS, fieldName } from "../../server/pricing-draft.ts";
import { approveFxAction, saveRuleAction, setFxAction } from "../../server/pricing-actions.ts";
import type { Loaded, PricingScreen } from "../../server/pricing-data.ts";

const RESULT_CODES = [
  "ok",
  "replayed",
  "pending",
  "approved",
  "invalid",
  "denied",
  "conflict",
  "not_found",
  "rate_limited",
  "unavailable",
  "second_admin_required",
  "must_differ_from_actor",
  "not_an_approver",
] as const;
type ResultCode = (typeof RESULT_CODES)[number];

export const resultOf = (value: string | null): ResultCode | null =>
  RESULT_CODES.find((c) => c === value) ?? null;

function Banner({ code }: { code: ResultCode | null }) {
  const t = useTranslations("AdminPricing.result");
  if (code === null) return null;
  const good = code === "ok" || code === "replayed" || code === "pending" || code === "approved";
  return (
    <p role={good ? "status" : "alert"} className="form-text seccolor mb-3">
      {t(code)}
    </p>
  );
}

function MarketForm({ locale, screen }: { locale: Locale; screen: PricingScreen }) {
  const t = useTranslations("AdminPricing.market");
  return (
    <form method="get" action={localePath(locale, "/pricing")} className="mb-4">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="market-select">
          {t("label")}
        </label>
        <select
          id="market-select"
          name="market"
          className="form-control"
          defaultValue={screen.market}
        >
          {screen.markets.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="primary" size="sm">
        {t("submit")}
      </Button>
    </form>
  );
}

function ReasonField({ id }: { id: string }) {
  const t = useTranslations("AdminPricing.reason");
  return (
    <Field
      name="reason"
      id={id}
      label={t("label")}
      hint={t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

function Hidden({ locale, market }: { locale: Locale; market: string }) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="market" value={market} />
    </>
  );
}

function FxCard({
  locale,
  screen,
  admin,
}: {
  locale: Locale;
  screen: PricingScreen;
  admin: AdminActor;
}) {
  const t = useTranslations("AdminPricing.fx");
  const columns: DataTableColumn<FxRateRow>[] = [
    { key: "rate", header: t("rate"), cell: (row) => row.rate },
    {
      key: "from",
      header: t("from"),
      cell: (row) => <DateText value={row.effectiveFrom} variant="datetime" />,
    },
  ];
  const pending =
    screen.pending !== null && screen.pending.status === "pending" ? screen.pending : null;
  return (
    <Card title={t("title")}>
      <p className="mb-3">
        {t("inForce")}:{" "}
        <strong>{screen.fxInForce === null ? t("none") : screen.fxInForce.rate}</strong>
      </p>
      {screen.fxHistory.length === 0 ? (
        <EmptyState title={t("none")} description="" />
      ) : (
        <DataTable
          caption={t("caption")}
          columns={columns}
          rows={[...screen.fxHistory]}
          rowKey={(row) => row.id}
        />
      )}
      {pending !== null ? (
        <PendingChange locale={locale} pending={pending} admin={admin} market={screen.market} />
      ) : null}
      <h3 className="h5 mergecolor">{t("setTitle")}</h3>
      <form action={setFxAction}>
        <Hidden locale={locale} market={screen.market} />
        <FormBlock>
          <Field
            name="rate"
            id="fx-rate"
            label={t("rateLabel")}
            hint={t("rateHint")}
            required
            maxLength={14}
            autoComplete="off"
            inputMode="decimal"
          />
          <Field
            name="from"
            id="fx-from"
            type="text"
            label={t("fromLabel")}
            hint="2026-12-01T09:00"
            optional
            maxLength={16}
            autoComplete="off"
          />
          <ReasonField id="fx-reason" />
        </FormBlock>
        <p className="form-text seccolor">
          {t("bigChange", { percent: String(FX_SECOND_ADMIN_PERCENT) })}
        </p>
        <SubmitButton variant="primary" size="sm">
          {t("submit")}
        </SubmitButton>
      </form>
    </Card>
  );
}

function PendingChange({
  locale,
  pending,
  admin,
  market,
}: {
  locale: Locale;
  pending: FxChange;
  admin: AdminActor;
  market: string;
}) {
  const t = useTranslations("AdminPricing.fx");
  const mine = pending.requestedBy.toLowerCase() === admin.adminId.toLowerCase();
  return (
    <div className="mb-4">
      <h3 className="h5 mergecolor">{t("pendingTitle")}</h3>
      <p className="mb-1">
        {t("pendingBody", { rate: pending.rate, who: pending.requestedBy.slice(0, 8) })}
      </p>
      <p className="mb-2">
        {t("expires")}: <DateText value={pending.expiresAt} variant="datetime" />
      </p>
      {mine ? (
        <p className="form-text seccolor">{t("mine")}</p>
      ) : (
        <form action={approveFxAction}>
          <Hidden locale={locale} market={market} />
          <ReasonField id="fx-approve-reason" />
          <p className="form-text seccolor">{t("approveHint")}</p>
          <SubmitButton variant="primary" size="sm">
            {t("approveSubmit")}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

function RulesCard({ screen }: { screen: PricingScreen }) {
  const t = useTranslations("AdminPricing.rules");
  const now = screen.now.getTime();
  // The newest start that has begun, for each scope, is the rule in force.
  const inForce = new Map<string, string>();
  for (const rule of screen.rules) {
    const scope = rule.productFamily ?? "";
    if (rule.effectiveFrom.getTime() <= now && !inForce.has(scope)) inForce.set(scope, rule.id);
  }
  const stateOf = (rule: PricingRuleRow): "inForce" | "scheduled" | "past" =>
    rule.effectiveFrom.getTime() > now
      ? "scheduled"
      : inForce.get(rule.productFamily ?? "") === rule.id
        ? "inForce"
        : "past";
  const columns: DataTableColumn<PricingRuleRow>[] = [
    { key: "scope", header: t("scope"), cell: (row) => row.productFamily ?? t("scopeAll") },
    {
      key: "from",
      header: t("from"),
      cell: (row) => <DateText value={row.effectiveFrom} variant="datetime" />,
    },
    { key: "state", header: t("status"), cell: (row) => t(stateOf(row)) },
    {
      key: "steps",
      header: t("steps"),
      cell: (row) =>
        (row.steps as { code?: string; rate?: string; base?: string }[])
          .map((s) =>
            t("stepFormat", { code: s.code ?? "", rate: s.rate ?? "", base: s.base ?? "" }),
          )
          .join(", "),
    },
  ];
  return (
    <Card title={t("title")}>
      {screen.rules.length === 0 ? (
        <EmptyState title={t("empty")} description="" />
      ) : (
        <DataTable
          caption={t("caption")}
          columns={columns}
          rows={[...screen.rules]}
          rowKey={(row) => row.id}
        />
      )}
    </Card>
  );
}

function BaseSelect({ name, id, value }: { name: string; id: string; value: string }) {
  const t = useTranslations("AdminPricing.editor");
  return (
    <div className="position-relative mb-3">
      <label className="seccolor" htmlFor={id}>
        {t("base")}
      </label>
      <select id={id} name={name} className="form-control" defaultValue={value}>
        <option value="aws">{t("baseAws")}</option>
        <option value="subtotal">{t("baseSubtotal")}</option>
      </select>
    </div>
  );
}

function EditorCard({ locale, screen }: { locale: Locale; screen: PricingScreen }) {
  const t = useTranslations("AdminPricing.editor");
  const names = useTranslations("AdminCatalog.flags.names");
  const rows = Math.min(MAX_DRAFT_STEPS, screen.draft.steps.length + 1);
  const blank = { code: "", rate: "", base: "aws", bn: "", en: "" };
  return (
    <Card title={t("title")}>
      <p className="form-text seccolor">{t("intro")}</p>
      <form method="get" action={localePath(locale, "/pricing")}>
        <input type="hidden" name="market" value={screen.market} />
        <input type="hidden" name="go" value="1" />
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor="edit-family">
            {t("family")}
          </label>
          <select
            id="edit-family"
            name="family"
            className="form-control"
            defaultValue={screen.draft.family ?? ""}
          >
            <option value="">{t("allFamilies")}</option>
            {FEATURE_FLAGS.map((key) => (
              <option key={key} value={key}>
                {names(key)}
              </option>
            ))}
          </select>
        </div>
        {Array.from({ length: rows }, (_, i) => {
          const step = screen.draft.steps[i] ?? blank;
          return (
            <FormBlock key={i} className="mb-3">
              <h3 className="h5 mergecolor">{t("step", { n: i + 1 })}</h3>
              <Field
                name={fieldName("code", i)}
                id={`edit-code-${i}`}
                label={t("code")}
                defaultValue={step.code}
                maxLength={40}
                autoComplete="off"
              />
              <Field
                name={fieldName("rate", i)}
                id={`edit-rate-${i}`}
                label={t("rate")}
                hint={t("rateHint")}
                defaultValue={step.rate}
                maxLength={20}
                autoComplete="off"
                inputMode="decimal"
              />
              <BaseSelect name={fieldName("base", i)} id={`edit-base-${i}`} value={step.base} />
              <Field
                name={fieldName("bn", i)}
                id={`edit-bn-${i}`}
                label={t("labelBn")}
                defaultValue={step.bn}
                maxLength={80}
                autoComplete="off"
              />
              <Field
                name={fieldName("en", i)}
                id={`edit-en-${i}`}
                label={t("labelEn")}
                defaultValue={step.en}
                maxLength={80}
                autoComplete="off"
              />
            </FormBlock>
          );
        })}
        <Field
          name="from"
          id="edit-from"
          label={t("from")}
          hint={t("fromHint")}
          defaultValue={screen.draft.from}
          optional
          maxLength={16}
          autoComplete="off"
        />
        <Field
          name="fx"
          id="edit-fx"
          label={t("fx")}
          hint={t("fxHint")}
          defaultValue={screen.draft.fx}
          optional
          maxLength={14}
          autoComplete="off"
          inputMode="decimal"
        />
        <Button type="submit" variant="secondary" size="sm">
          {t("previewSubmit")}
        </Button>
      </form>
    </Card>
  );
}

function PreviewTable({ rows }: { rows: readonly PreviewRow[] }) {
  const t = useTranslations("AdminPricing.preview");
  const known = ["instance_5", "instance_24", "instance_84", "disk_80gb", "backup_1gb_day"];
  const columns: DataTableColumn<PreviewRow>[] = [
    {
      key: "sample",
      header: t("sample"),
      cell: (row) =>
        known.includes(row.sampleId)
          ? t(`samples.${row.sampleId}` as "samples.disk_80gb")
          : row.sampleId,
    },
    { key: "aws", header: t("aws"), cell: (row) => row.awsPriceUsd },
    {
      key: "current",
      header: t("current"),
      cell: (row) =>
        row.current === null ? t("none") : <MoneyText minor={row.current.totalMinor} />,
    },
    {
      key: "candidate",
      header: t("candidate"),
      cell: (row) => <MoneyText minor={row.candidate.totalMinor} />,
    },
    {
      key: "change",
      header: t("change"),
      cell: (row) => (row.deltaMinor === null ? "-" : <MoneyText minor={row.deltaMinor} />),
    },
  ];
  return (
    <DataTable
      caption={t("caption")}
      columns={columns}
      rows={[...rows]}
      rowKey={(row) => row.sampleId}
    />
  );
}

function PreviewCard({ locale, screen }: { locale: Locale; screen: PricingScreen }) {
  const t = useTranslations("AdminPricing.preview");
  if (screen.preview.kind === "none") return null;
  const { draft } = screen;
  return (
    <Card title={t("title")}>
      {screen.preview.kind === "invalid" ? (
        <p role="alert">{t("invalid", { fields: screen.preview.fields.join(", ") })}</p>
      ) : screen.preview.kind === "unavailable" ? (
        <p role="alert">{t("unavailable")}</p>
      ) : (
        <>
          <PreviewTable rows={screen.preview.rows} />
          {draft.steps.length > 0 ? (
            <form action={saveRuleAction}>
              <h3 className="h5 mergecolor">{t("saveTitle")}</h3>
              <Hidden locale={locale} market={screen.market} />
              <input type="hidden" name="family" value={draft.family ?? ""} />
              <input type="hidden" name="from" value={draft.from} />
              {draft.steps.map((s, i) => (
                <span key={i}>
                  <input type="hidden" name={fieldName("code", i)} value={s.code} />
                  <input type="hidden" name={fieldName("rate", i)} value={s.rate} />
                  <input type="hidden" name={fieldName("base", i)} value={s.base} />
                  <input type="hidden" name={fieldName("bn", i)} value={s.bn} />
                  <input type="hidden" name={fieldName("en", i)} value={s.en} />
                </span>
              ))}
              <ReasonField id="rule-reason" />
              <SubmitButton variant="primary" size="sm">
                {t("save")}
              </SubmitButton>
            </form>
          ) : null}
        </>
      )}
    </Card>
  );
}

export interface PricingViewProps {
  locale: Locale;
  admin: AdminActor;
  screen: Loaded<PricingScreen>;
  result: string | null;
}

// 16.12 /pricing: FX rate with history and the two-person approval, pricing rules with the editor whose
// save button exists only under a good preview of the five sample products.
export function PricingView({ locale, admin, screen, result }: PricingViewProps) {
  const t = useTranslations("AdminPricing");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <form method="get" action={localePath(locale, "/pricing/book")} className="mb-3">
        <Button type="submit" variant="secondary" size="sm">
          {t("bookLink")}
        </Button>
      </form>
      <form method="get" action={localePath(locale, "/pricing/config")} className="mb-3">
        <Button type="submit" variant="secondary" size="sm">
          {t("configLink")}
        </Button>
      </form>
      <form method="get" action={localePath(locale, "/pricing/seller")} className="mb-3">
        <Button type="submit" variant="secondary" size="sm">
          {t("sellerLink")}
        </Button>
      </form>
      <Banner code={resultOf(result)} />
      {screen.kind !== "ok" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : (
        <>
          <Card>
            <MarketForm locale={locale} screen={screen.value} />
          </Card>
          <FxCard locale={locale} screen={screen.value} admin={admin} />
          <RulesCard screen={screen.value} />
          <EditorCard locale={locale} screen={screen.value} />
          <PreviewCard locale={locale} screen={screen.value} />
        </>
      )}
    </>
  );
}
