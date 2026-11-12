export * from "./sms/index";
export * from "./otp/index";

// WP5-T5: the queue (F's `notify`), the templates, the providers and the delivery loop.
export { notify, planRows, rowKey } from "./queue/notify";
export type { NotifyInput, PlannedRow } from "./queue/notify";
export { waitlistNoticeToInput } from "./queue/waitlist";
export type { WaitlistNoticeLike } from "./queue/waitlist";
export { TEMPLATE_IDS, DIRECT_ONLY_IDS, NotifyError } from "./queue/types";
export type { TemplateId, Channel, NotifyErrorCode } from "./queue/types";
export { runNotifier, MAX_ATTEMPTS } from "./queue/run";
export type { NotifierDeps, NotifierReport } from "./queue/run";
export { createPgStore, InMemoryNotifierStore, BACKOFF_MINUTES, isDue } from "./queue/store";
export type { NotifierStore, Recipient, StoredRow } from "./queue/store";
export {
  renderEmail,
  renderSms,
  renderInApp,
  parseTemplateData,
  channelsOf,
} from "./templates/render";
export type { RenderContext, RenderedEmail, RenderedInApp } from "./templates/render";
export { COGNITO_MESSAGE_KINDS, renderCognitoMessage } from "./templates/cognito";
export type {
  CognitoMessageKind,
  CognitoPlaceholders,
  RenderedCognitoMessage,
} from "./templates/cognito";
export { PRODUCT_KEYS, productPath } from "./templates/defs";
export type { ProductKey } from "./templates/defs";
export { formatMoney, formatDhakaDate } from "./text/format";
export { scanSecrets, smsLength } from "./text/guards";
export { SesEmailProvider, InMemoryEmailProvider } from "./email/provider";
export type {
  EmailProvider,
  EmailMessage,
  EmailSendResult,
  SesTransport,
  SesRequest,
  SesEmailOptions,
} from "./email/provider";
export { GatewaySmsProvider } from "./sms/gateway";
export type { SmsTransport, SmsTransportResult, GatewaySmsOptions } from "./sms/gateway";
