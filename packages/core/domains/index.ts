export {
  DOMAIN_MAX_LABEL_LENGTH,
  DOMAIN_MAX_NAME_LENGTH,
  normalizeDomainName,
  type DomainName,
} from "./name";
export { decideTld, tldPolicyOf, type TldDecision, type TldRow } from "./tld";
export { checkSecondConfirmation } from "./confirm";
export {
  CONTACT_TYPES,
  parseRegistrantContact,
  redactContact,
  type ContactType,
  type RegistrantContact,
} from "./contact";
export {
  DOMAIN_EVENTS,
  DOMAIN_STATES,
  canMoveDomain,
  nextDomainState,
  type DomainEvent,
  type DomainState,
} from "./state";
export {
  RENEWAL_REMINDER_DAYS,
  RENEW_LEAD_DAYS,
  domainRenewalAction,
  type RenewalAction,
  type RenewalFacts,
} from "./renewal";
export {
  DOMAIN_FLAG,
  DOMAIN_REGION,
  DOMAIN_TERM_DAYS,
  DOMAIN_YEARS,
  parseDomainConfig,
  resolveDomain,
  type DomainConfig,
  type ResolvedDomain,
  type TldProduct,
} from "./resolve";
