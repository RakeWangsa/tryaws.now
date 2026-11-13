import { useTranslations } from "next-intl";
import { Badge, Card, DateText, EmptyState, Field, FormBlock, SubmitButton } from "@tc/ui";
import type { AdminActor } from "@tc/db";
import type { Locale } from "@tc/ui/runtime";
import { switchUnpaidRuleAction } from "../../server/ops-actions.ts";
import type { Loaded } from "../../server/ops-data.ts";
import type { UnpaidRuleLine, UnpaidRuleScreen } from "../../server/unpaid-rule-data.ts";
import { UNPAID_RULE_OFF_ROLES, UNPAID_RULE_ON_ROLES } from "../../server/unpaid-rule-flow.ts";

// WPU-Z4 /operations/unpaid-rule: the switch of the daily unpaid-usage job for each market, as the job reads
// it, its last change from the audit log, and what the rule does. A superadmin may turn it on (with a reason
// and the confirm box); ops and superadmin may turn it off (with a reason); finance and support read. The
// admin is shown as a short id, never an e-mail (R14).

const RESULT_CODES = [
  "ok",
  "replayed",
  "invalid",
  "denied",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
] as const;
type ResultCode = (typeof RESULT_CODES)[number];

export function unpaidRuleResultOf(value: unknown): ResultCode | null {
  return RESULT_CODES.find((code) => code === value) ?? null;
}

function Banner({ code }: { code: ResultCode | null }) {
  const t = useTranslations("AdminUnpaidRule.result");
  if (code === null) return null;
  const good = code === "ok" || code === "replayed";
  return (
    <p role={good ? "status" : "alert"} className="form-text seccolor mb-3">
      {t(code)}
    </p>
  );
}

function About() {
  const t = useTranslations("AdminUnpaidRule.about");
  return (
    <Card title={t("title")}>
      <ul className="mb-0">
        <li>{t("retry")}</li>
        <li>{t("suspend")}</li>
        <li>{t("delete")}</li>
        <li>{t("approval")}</li>
        <li>{t("off")}</li>
      </ul>
    </Card>
  );
}

function LastChange({ line }: { line: UnpaidRuleLine }) {
  const t = useTranslations("AdminUnpaidRule.last");
  const change = line.lastChange;
  return (
    <>
      <h3 className="h5 mergecolor">{t("title")}</h3>
      {change === null ? (
        <p>{t("none")}</p>
      ) : (
        <ul className="list-unstyled mb-3">
          <li>
            {t("change")}: <strong>{change.enabled ? t("turnedOn") : t("turnedOff")}</strong>
          </li>
          <li>
            {t("by")}: {change.by === null ? "-" : `#${change.by.slice(0, 8)}`}
          </li>
          <li>
            {t("when")}: <DateText value={change.at} variant="datetime" />
          </li>
          <li>
            {t("reason")}: {change.reason ?? "-"}
          </li>
        </ul>
      )}
    </>
  );
}

function SwitchForm({
  locale,
  line,
  turnOn,
}: {
  locale: Locale;
  line: UnpaidRuleLine;
  turnOn: boolean;
}) {
  const t = useTranslations("AdminUnpaidRule");
  const id = (name: string): string => `unpaid-${line.market}-${turnOn ? "on" : "off"}-${name}`;
  return (
    <form action={switchUnpaidRuleAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="market" value={line.market} />
      <input type="hidden" name="state" value={turnOn ? "on" : "off"} />
      <h3 className="h5 mergecolor">{turnOn ? t("turnOn.title") : t("turnOff.title")}</h3>
      <FormBlock>
        <Field
          name="reason"
          id={id("reason")}
          label={t("reason.label")}
          hint={t("reason.hint")}
          required
          maxLength={500}
          autoComplete="off"
        />
        {turnOn ? (
          <div className="position-relative mb-3">
            <label className="seccolor" htmlFor={id("confirm")}>
              <input
                type="checkbox"
                id={id("confirm")}
                name="confirm"
                value="on"
                required
                className="me-2"
              />
              {t("turnOn.confirm")}
            </label>
          </div>
        ) : null}
      </FormBlock>
      {/* Turning on leads to suspensions and deletion requests: the button of a destructive action. */}
      <SubmitButton variant={turnOn ? "destructive" : "primary"} size="sm">
        {turnOn ? t("turnOn.submit") : t("turnOff.submit")}
      </SubmitButton>
    </form>
  );
}

function MarketCard({
  locale,
  admin,
  line,
}: {
  locale: Locale;
  admin: AdminActor;
  line: UnpaidRuleLine;
}) {
  const t = useTranslations("AdminUnpaidRule");
  // On: offered to the roles that turn it on while it is off. Off: offered to the roles that turn it off
  // while it is on, or while the stored value is not a boolean (turning off stores a clean false).
  const canOn = UNPAID_RULE_ON_ROLES.includes(admin.role) && !line.enabled;
  const canOff =
    UNPAID_RULE_OFF_ROLES.includes(admin.role) && (line.enabled || line.source === "invalid");
  const reader =
    !UNPAID_RULE_ON_ROLES.includes(admin.role) && !UNPAID_RULE_OFF_ROLES.includes(admin.role);
  return (
    <Card title={t("market", { market: line.market })}>
      <p className="mb-2">
        {t("state.label")}:{" "}
        <Badge tone={line.enabled ? "purple" : "grey"}>
          {line.enabled ? t("state.on") : t("state.off")}
        </Badge>
      </p>
      {line.source === "stored" ? null : (
        <p role={line.source === "invalid" ? "alert" : undefined} className="form-text seccolor">
          {t(`source.${line.source}`)}
        </p>
      )}
      <LastChange line={line} />
      {canOn ? <SwitchForm locale={locale} line={line} turnOn /> : null}
      {canOff ? <SwitchForm locale={locale} line={line} turnOn={false} /> : null}
      {reader ? <p className="form-text seccolor mb-0">{t("readOnly")}</p> : null}
    </Card>
  );
}

export interface UnpaidRuleViewProps {
  locale: Locale;
  admin: AdminActor;
  screen: Loaded<UnpaidRuleScreen>;
  result: ResultCode | null;
}

export function UnpaidRuleView({ locale, admin, screen, result }: UnpaidRuleViewProps) {
  const t = useTranslations("AdminUnpaidRule");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p className="form-text seccolor">{t("intro")}</p>
      <Banner code={result} />
      <About />
      <p className="form-text seccolor">{t("roles")}</p>
      {screen.kind !== "ok" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : screen.value.lines.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        screen.value.lines.map((line) => (
          <MarketCard key={line.market} locale={locale} admin={admin} line={line} />
        ))
      )}
    </>
  );
}
