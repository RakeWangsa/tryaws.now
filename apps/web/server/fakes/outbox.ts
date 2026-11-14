import { InMemorySmsProvider } from "@tc/notify";

// Development and test only. The process-wide state of the fake identity provider and of the fake
// SMS gateway, kept on globalThis so that the server runtime, the Server Actions and the two dev
// routes (which Next may bundle apart) see the same data. The codes are readable only through the
// two /dev/*/outbox routes, which answer 404 unless the fake switches are on. Imported through the
// literal dynamic import in runtime.ts and by the two dev routes in this folder's tests only.

export interface EmailCodeEntry {
  readonly kind: "signup" | "reset";
  readonly code: string;
  readonly issuedAtMs: number;
}

export interface FakeUser {
  readonly sub: string;
  password: string;
  confirmed: boolean;
  readonly name: string;
  readonly locale: "bn" | "en";
  refreshCount: number;
  // WPU-X11: the authenticator of the fake identity (fakes/totp.ts). `pending` is the secret of an
  // enrolment not yet confirmed; `secret` the one in use when `totpEnabled`; `lastStep` the 30-second step
  // of the last accepted code (a code is accepted once: replay refused).
  totpPending?: string;
  totpSecret?: string;
  totpEnabled?: boolean;
  totpLastStep?: number;
}

export interface FakeState {
  readonly users: Map<string, FakeUser>;
  readonly emailCodes: Map<string, EmailCodeEntry>;
  readonly issuedRefresh: Set<string>;
  sms: InMemorySmsProvider | null;
}

const KEY = "__tcFakeIdentityState";

export function getFakeState(): FakeState {
  const holder = globalThis as unknown as Record<string, FakeState | undefined>;
  const known = holder[KEY];
  if (known !== undefined) return known;
  const made: FakeState = {
    users: new Map(),
    emailCodes: new Map(),
    issuedRefresh: new Set(),
    sms: null,
  };
  holder[KEY] = made;
  return made;
}

/** The one fake SMS gateway of the process. The constructor refuses outside development and test. */
export function getFakeSms(): InMemorySmsProvider {
  const state = getFakeState();
  state.sms ??= new InMemorySmsProvider();
  return state.sms;
}

/** For tests: forget every user, code and message. */
export function resetFakeState(): void {
  const state = getFakeState();
  state.users.clear();
  state.emailCodes.clear();
  state.issuedRefresh.clear();
  state.sms?.reset();
}
