// WP7-T4, 16.10: the states of a registered domain and the events that move it. Pure. A move that is not
// in the table is `null`, never a guess (R16). There is no event that deletes a domain: a domain expires
// and TiCON never deletes it (R13).

export const DOMAIN_STATES = [
  "pending",
  "review",
  "awaiting_verification",
  "registered",
  "failed",
  "expired",
] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];

export const DOMAIN_EVENTS = [
  "needs_review",
  "approved",
  "rejected",
  "registration_succeeded",
  "registration_failed",
  "contact_verified",
  "expiry_passed",
  "renewed",
] as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

const TABLE: Readonly<Record<DomainState, Partial<Record<DomainEvent, DomainState>>>> = {
  pending: {
    needs_review: "review",
    registration_succeeded: "awaiting_verification",
    registration_failed: "failed",
  },
  review: { approved: "pending", rejected: "failed" },
  awaiting_verification: {
    contact_verified: "registered",
    expiry_passed: "expired",
    renewed: "awaiting_verification",
  },
  registered: { expiry_passed: "expired", renewed: "registered" },
  failed: {},
  expired: { renewed: "registered" },
};

function isState(text: string): text is DomainState {
  return (DOMAIN_STATES as readonly string[]).includes(text);
}
function isEvent(text: string): text is DomainEvent {
  return (DOMAIN_EVENTS as readonly string[]).includes(text);
}

export function nextDomainState(from: string, event: string): DomainState | null {
  if (!isState(from) || !isEvent(event)) return null;
  return TABLE[from][event] ?? null;
}

export function canMoveDomain(from: string, to: string): boolean {
  if (!isState(from) || !isState(to)) return false;
  return Object.values(TABLE[from]).includes(to);
}
