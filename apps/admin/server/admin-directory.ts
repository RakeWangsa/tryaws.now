// The admin directory: the Cognito admin pool as the /admins screen needs it (invite, sign-in facts,
// enable and disable, TOTP reset). It sits behind a port because the real Cognito admin API calls need
// the admin pool, a role that may call them and a manual VERIFY against it; this file holds the port, a
// refusing default and a fake for tests. No AWS SDK import here (R1, R17), no secret (R3).

export interface DirectoryEntry {
  // Shown masked only (R14).
  readonly email: string;
  readonly lastSignInAt: Date | null;
  readonly totpEnrolled: boolean;
}

export interface AdminDirectory {
  // Creates the pool user (no password, no self sign-up) and sends the invitation. The same email gives
  // the same sub (idempotent, R7). Returns the Cognito sub.
  invite(email: string): Promise<{ readonly sub: string }>;
  // The facts of the given subs; a sub the pool does not know is missing from the answer.
  describe(subs: readonly string[]): Promise<ReadonlyMap<string, DirectoryEntry>>;
  // Enables or disables the pool user (a disable also signs it out everywhere).
  setEnabled(sub: string, enabled: boolean): Promise<void>;
  // Removes the second factor so that the next sign-in enrols a new one.
  resetMfa(sub: string): Promise<void>;
}

// The default until the real adapter is wired: every call refuses and the app fails closed (R16).
export const unavailableAdminDirectory: AdminDirectory = {
  invite: async () => {
    throw new Error("admin directory: not configured");
  },
  describe: async () => {
    throw new Error("admin directory: not configured");
  },
  setEnabled: async () => {
    throw new Error("admin directory: not configured");
  },
  resetMfa: async () => {
    throw new Error("admin directory: not configured");
  },
};

export type FakeCall =
  | readonly ["invite", string]
  | readonly ["describe", readonly string[]]
  | readonly ["setEnabled", string, boolean]
  | readonly ["resetMfa", string];

// For tests: remembers the calls, invites idempotently, and can be told to fail.
export function fakeAdminDirectory(
  options: { failing?: boolean; entries?: Record<string, DirectoryEntry> } = {},
): AdminDirectory & { readonly calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const subs = new Map<string, string>();
  const refuse = () => {
    if (options.failing === true) throw new Error("fake directory: down");
  };
  return {
    calls,
    invite: async (email) => {
      calls.push(["invite", email]);
      refuse();
      let sub = subs.get(email);
      if (sub === undefined) {
        sub = `fake-sub-${subs.size + 1}-${email.length}`;
        subs.set(email, sub);
      }
      return { sub };
    },
    describe: async (list) => {
      calls.push(["describe", list]);
      refuse();
      const out = new Map<string, DirectoryEntry>();
      for (const sub of list) {
        const entry = options.entries?.[sub];
        if (entry !== undefined) out.set(sub, entry);
      }
      return out;
    },
    setEnabled: async (sub, enabled) => {
      calls.push(["setEnabled", sub, enabled]);
      refuse();
    },
    resetMfa: async (sub) => {
      calls.push(["resetMfa", sub]);
      refuse();
    },
  };
}
