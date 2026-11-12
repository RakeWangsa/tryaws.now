// WP9-T2 sweep: the register of the endpoints of apps/web and the test that proves each one.
// apps/web/server/endpoint-sweep.test.ts scans app/ for every Server Action, route handler and page with
// an id in its path, and fails when one is missing here, when an entry has no endpoint any more, and when
// a proof names a test that does not exist (file and title are searched). Add the endpoint here with its
// proof when you add the endpoint.
//
//   id       takes the id of a resource or a payment from the form or the URL. The proof is a test that
//            shows another customer's id answers like a missing one and writes nothing (R8).
//   session  acts only on the customer of the session; no id of a customer's row comes from the request.
//            The proof shows the session is read first (R9) and that the customer is the session's.
//   public   before sign-in: no customer data in or out. The proof shows the answer does not tell who exists.
//   gateway  the browser comes back from EPS or a browser reports to us: no customer data, fixed answers.
//   dev      a development surface that answers 404 outside the local stage.

export type EndpointKind = "id" | "session" | "public" | "gateway" | "dev";
export interface Proof {
  /** Path from the repository root. */
  readonly file: string;
  /** A literal piece of the title of the `it`/`describe` in that file. */
  readonly test: string;
}
export interface EndpointEntry {
  readonly kind: EndpointKind;
  readonly proof: readonly Proof[];
}

const W = "apps/web/server/";
const proof = (file: string, test: string): Proof => ({ file, test });

const EXTRAS = proof(
  `${W}extras-actions.test.ts`,
  "every action on an unknown id is not_found and writes nothing",
);
const ORDER_SESSION = proof(
  `${W}order-actions.test.ts`,
  "refuses without a session and runs nothing else",
);
const DRAFT_ORDER_R9 = proof(
  `${W}cdn-actions.test.ts`,
  "refuses an unauthenticated request, a bad form and a rate limit",
);
const CUSTOMER_REPOS = proof(
  "packages/db/test/cross-tenant.test.ts",
  "every method of customerRepos has a cross-tenant case",
);
const SETTINGS_ORDER = proof(
  `${W}settings-actions.test.ts`,
  "authenticates, validates, rate limits, writes and audits, in that order",
);

export const ENDPOINTS: Readonly<Record<string, EndpointEntry>> = {
  // ---- (auth): before sign-in
  "app/[locale]/(auth)/forgot-password/actions.ts#requestResetAction": {
    kind: "public",
    proof: [
      proof(`${W}auth/enumeration.test.ts`, "forgot password: a known and an unknown address"),
    ],
  },
  "app/[locale]/(auth)/login/actions.ts#signInAction": {
    kind: "public",
    proof: [
      proof(
        `${W}auth/enumeration.test.ts`,
        "sign-in: a wrong password, an unknown address and an unconfirmed address",
      ),
    ],
  },
  "app/[locale]/(auth)/reset-password/actions.ts#resetPasswordAction": {
    kind: "public",
    proof: [proof(`${W}auth/enumeration.test.ts`, "reset: a wrong code and an unknown address")],
  },
  "app/[locale]/(auth)/signup/actions.ts#signUpAction": {
    kind: "public",
    proof: [proof(`${W}auth/enumeration.test.ts`, "sign-up: a new address and an existing one")],
  },
  "app/[locale]/(auth)/verify/actions.ts#confirmEmailAction": {
    kind: "public",
    proof: [proof(`${W}auth/enumeration.test.ts`, "confirm: a wrong code and an unknown address")],
  },
  "app/[locale]/(auth)/verify/actions.ts#resendEmailCodeAction": {
    kind: "public",
    proof: [proof(`${W}auth/enumeration.test.ts`, "resend: a known and an unknown address")],
  },
  "app/[locale]/(auth)/verify/actions.ts#sendPhoneCodeAction": {
    kind: "session",
    proof: [
      proof(
        `${W}auth/phone.test.ts`,
        "without a session it sends the customer to sign in and sends nothing",
      ),
    ],
  },
  "app/[locale]/(auth)/verify/actions.ts#verifyPhoneCodeAction": {
    kind: "session",
    proof: [
      proof(
        `${W}auth/phone.test.ts`,
        "a customer with no challenge gets code_wrong, never a hint about others",
      ),
    ],
  },

  // ---- (panel): actions
  "app/[locale]/(panel)/sign-out-action.ts#signOutAction": {
    kind: "session",
    proof: [proof(`${W}auth/order.test.ts`, "each core runs its steps in the R9 order")],
  },
  "app/[locale]/(panel)/cdn/[id]/actions.ts#setCdnEnabledAction": {
    kind: "id",
    proof: [
      proof(
        `${W}cdn-actions.test.ts`,
        "another customer's distribution, a missing one and another family give one answer (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/cdn/[id]/actions.ts#destroyCdnAction": {
    kind: "id",
    proof: [
      proof(
        `${W}cdn-actions.test.ts`,
        "refuses a distribution that is not live, another customer's, and a flag that is off",
      ),
    ],
  },
  "app/[locale]/(panel)/cdn/new/actions.ts#createCdnDraftAction": {
    kind: "session",
    proof: [DRAFT_ORDER_R9],
  },
  "app/[locale]/(panel)/databases/[id]/access-actions.ts#revealDatabasePasswordAction": {
    kind: "id",
    proof: [
      proof(
        `${W}databases-access.test.ts`,
        "another customer's database and a missing one give one answer and never reach the port (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/actions.ts#destroyDatabaseAction": {
    kind: "id",
    proof: [
      proof(
        `${W}family-actions.test.ts`,
        "refuses a resource that is not live, not the customer's, an empty name, a flag that is off and a conflict",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/actions.ts#setDatabaseRunningAction": {
    kind: "id",
    proof: [
      proof(
        `${W}family-actions.test.ts`,
        "a flag that is off writes nothing (R12); another customer's row, a missing one and another family are one answer (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/new/actions.ts#createDatabaseDraftAction": {
    kind: "session",
    proof: [
      proof(
        `${W}databases-actions.test.ts`,
        "refuses an unauthenticated request, a bad form and a rate limit, in that order (R9)",
      ),
    ],
  },
  "app/[locale]/(panel)/load-balancers/[id]/actions.ts#destroyLoadBalancerAction": {
    kind: "id",
    proof: [
      proof(
        `${W}family-actions.test.ts`,
        "refuses a resource that is not live, not the customer's, an empty name, a flag that is off and a conflict",
      ),
    ],
  },
  "app/[locale]/(panel)/load-balancers/[id]/actions.ts#setLoadBalancerTargetsAction": {
    kind: "id",
    proof: [
      proof(
        `${W}load-balancers-actions.test.ts`,
        "another customer's server and a missing one give the same answer, and the port is never called",
      ),
    ],
  },
  "app/[locale]/(panel)/load-balancers/new/actions.ts#createLoadBalancerDraftAction": {
    kind: "session",
    proof: [
      proof(
        `${W}load-balancers-actions.test.ts`,
        "asks for at least one target, refuses a bad id, an unauthenticated request and a rate limit (R9)",
      ),
    ],
  },
  "app/[locale]/(panel)/containers/[id]/actions.ts#deployContainersAction": {
    kind: "id",
    proof: [
      proof(
        `${W}container-actions.test.ts`,
        "only an active service is deployed to; another customer's service is not_found (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/containers/[id]/actions.ts#destroyContainerServiceAction": {
    kind: "id",
    proof: [
      proof(
        `${W}container-actions.test.ts`,
        "is cross-tenant safe and refuses a service that is gone",
      ),
    ],
  },
  "app/[locale]/(panel)/containers/new/actions.ts#createContainerDraftAction": {
    kind: "session",
    proof: [
      proof(
        `${W}container-actions.test.ts`,
        "refuses without a session before the validation, the limit and the order code",
      ),
    ],
  },
  "app/[locale]/(panel)/kyc/actions.ts#startKycUploadAction": {
    kind: "session",
    proof: [proof(`${W}kyc-actions.test.ts`, "refuses without a session, before anything else")],
  },
  "app/[locale]/(panel)/kyc/actions.ts#submitKycAction": {
    kind: "session",
    proof: [proof(`${W}kyc-actions.test.ts`, "never takes an object key from the request")],
  },
  "app/[locale]/(panel)/notifications/actions.ts#markNotificationsReadAction": {
    kind: "id",
    proof: [
      proof(
        `${W}extras-actions.test.ts`,
        "a customerId in the form is ignored: the store is opened for the session's customer only",
      ),
      CUSTOMER_REPOS,
    ],
  },
  "app/[locale]/(panel)/orders/review/actions.ts#placeOrderAction": {
    kind: "id",
    proof: [
      proof(
        "packages/core/orders/place.test.ts",
        "a token of customer A used by customer B is forbidden and writes nothing (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#createBackupAction": {
    kind: "id",
    proof: [EXTRAS],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#deleteBackupAction": {
    kind: "id",
    proof: [EXTRAS],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#setAutoBackupAction": {
    kind: "id",
    proof: [EXTRAS],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#attachDiskAction": { kind: "id", proof: [EXTRAS] },
  "app/[locale]/(panel)/servers/[id]/actions.ts#detachDiskAction": { kind: "id", proof: [EXTRAS] },
  "app/[locale]/(panel)/servers/[id]/actions.ts#destroyDiskAction": { kind: "id", proof: [EXTRAS] },
  "app/[locale]/(panel)/servers/[id]/actions.ts#setAutoRenewAction": {
    kind: "id",
    proof: [
      proof(
        `${W}extras-actions.test.ts`,
        "setAutoRenew on an unknown id is not_found, and nothing is written or audited",
      ),
    ],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#destroyServerAction": {
    kind: "id",
    proof: [EXTRAS],
  },
  "app/[locale]/(panel)/servers/[id]/windows-actions.ts#revealWindowsPasswordAction": {
    kind: "id",
    proof: [
      proof(
        `${W}windows-access.test.ts`,
        "another customer's server and a missing one give the same answer (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/servers/new/actions.ts#createOrderDraftAction": {
    kind: "session",
    proof: [ORDER_SESSION],
  },
  "app/[locale]/(panel)/settings/profile/actions.ts#updateProfileAction": {
    kind: "session",
    proof: [SETTINGS_ORDER],
  },
  "app/[locale]/(panel)/settings/profile/actions.ts#startEmailChangeAction": {
    kind: "session",
    proof: [
      proof(`${W}settings-actions.test.ts`, "start: needs a fresh sign-in before anything else"),
    ],
  },
  "app/[locale]/(panel)/settings/profile/actions.ts#confirmEmailChangeAction": {
    kind: "session",
    proof: [
      proof(
        `${W}settings-actions.test.ts`,
        "confirm: needs a fresh sign-in, then the right code, and only then stores the address",
      ),
    ],
  },
  "app/[locale]/(panel)/settings/profile/actions.ts#startPhoneChangeAction": {
    kind: "session",
    proof: [
      proof(
        `${W}settings-actions.test.ts`,
        "start: needs a fresh sign-in; the OTP service is not called without it",
      ),
    ],
  },
  "app/[locale]/(panel)/settings/profile/actions.ts#confirmPhoneChangeAction": {
    kind: "session",
    proof: [
      proof(
        `${W}settings-actions.test.ts`,
        "confirm: needs a fresh sign-in, then maps a wrong code, a good code and no challenge",
      ),
    ],
  },
  "app/[locale]/(panel)/settings/security/actions.ts#changePasswordAction": {
    kind: "session",
    proof: [proof(`${W}settings-actions.test.ts`, "needs a fresh sign-in")],
  },
  "app/[locale]/(panel)/settings/ssh-keys/actions.ts#addSshKeyAction": {
    kind: "session",
    proof: [
      proof(
        `${W}key-actions.test.ts`,
        "authenticates, validates, rate limits, writes and audits, in that order",
      ),
    ],
  },
  "app/[locale]/(panel)/settings/ssh-keys/actions.ts#removeSshKeyAction": {
    kind: "id",
    proof: [
      proof(
        `${W}key-actions.test.ts`,
        "answers not_found for a key that is not the customer's own",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/actions.ts#setBucketAccessAction": {
    kind: "id",
    proof: [
      proof(
        `${W}bucket-actions.test.ts`,
        "another customer's bucket, a missing one and another family answer the same: not_found (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/actions.ts#deleteAccessKeyAction": {
    kind: "id",
    proof: [
      proof(`${W}bucket-actions.test.ts`, "is cross-tenant safe (R8) and respects the flag (R12)"),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/actions.ts#destroyBucketAction": {
    kind: "id",
    proof: [
      proof(
        `${W}bucket-actions.test.ts`,
        "is cross-tenant safe and refuses a bucket that is already gone",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/key-actions.ts#createBucketKeyAction": {
    kind: "id",
    proof: [
      proof(
        `${W}bucket-keys.test.ts`,
        "takes the customer from the session, never from the input (R8), and passes the request id (R7)",
      ),
      proof(
        "functions/access-details/handler.test.ts",
        "customer B asking for A's server gets the answer of a missing resource, and AWS is not called",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/new/actions.ts#createBucketDraftAction": {
    kind: "session",
    proof: [
      proof(
        `${W}bucket-actions.test.ts`,
        "refuses without a session before the validation, the limit and the order code",
      ),
    ],
  },
  "app/[locale]/(panel)/wallet/topup/[paymentId]/actions.ts#recheckPaymentAction": {
    kind: "id",
    proof: [
      proof(
        "apps/web/app/[locale]/(panel)/wallet/topup/[paymentId]/actions.test.ts",
        "another customer's id is 'unknown' and EPS is never asked",
      ),
    ],
  },
  "app/[locale]/(panel)/wallet/topup/[paymentId]/actions.ts#checkAgainAction": {
    kind: "id",
    proof: [
      proof(
        "apps/web/app/[locale]/(panel)/wallet/topup/[paymentId]/actions.test.ts",
        "another customer's id is 'unknown' and EPS is never asked",
      ),
      proof(`${W}topup-core.test.ts`, "not_found (another customer's id) is 'unknown'"),
    ],
  },
  // ---- (public): before sign-in (WPP)
  "app/[locale]/(public)/products/[family]/actions.ts#notifyMeAction": {
    kind: "public",
    proof: [
      proof(`${W}public/notify-me.test.ts`, "is the same answer for a replay (R7)"),
      proof(
        `${W}public/notify-me.test.ts`,
        "answers 'unavailable' when the write fails, and the log line holds no address",
      ),
    ],
  },
  "app/[locale]/(public)/products/[family]/page.tsx": {
    kind: "public",
    proof: [
      proof(
        "apps/web/app/[locale]/(public)/public-pages.test.tsx",
        "shows the coming soon page with a notify-me form",
      ),
    ],
  },
  "app/[locale]/(public)/legal/[doc]/page.tsx": {
    kind: "public",
    proof: [
      proof(
        "apps/web/app/[locale]/(public)/public-pages.test.tsx",
        "every legal document is marked as a draft placeholder",
      ),
    ],
  },
  "app/[locale]/(panel)/wallet/topup/actions.ts#startTopUpAction": {
    kind: "session",
    proof: [
      proof(
        `${W}topup-core.test.ts`,
        "the customer is the session's: a customerId field in the form is ignored",
      ),
    ],
  },
  "app/[locale]/dev/eps/checkout/actions.ts#settleFakeEps": {
    kind: "dev",
    proof: [
      proof(
        "apps/web/dev-surface.test.ts",
        "refuses an unknown outcome, an unknown payment and an off surface, and settles nothing",
      ),
    ],
  },

  // ---- route handlers
  "app/api/csp-report/route.ts": {
    kind: "gateway",
    proof: [
      proof(
        "apps/web/app/api/csp-report/route.test.ts",
        "answers 204 and writes nothing for garbage",
      ),
    ],
  },
  "app/dev/idp/outbox/route.ts": {
    kind: "dev",
    proof: [proof(`${W}dev-routes.test.ts`, "answers 404 when the fake identity switch is off")],
  },
  "app/dev/sms/outbox/route.ts": {
    kind: "dev",
    proof: [proof(`${W}dev-routes.test.ts`, "answers 404 when the fake SMS switch is off")],
  },
  "app/[locale]/dev/sign-in/route.ts": {
    kind: "dev",
    proof: [
      proof(
        "apps/web/dev-surface.test.ts",
        "is a 404 when the surface is off, with no cookie (production stage with the fake switch)",
      ),
    ],
  },
  "app/pay/eps/success/route.ts": {
    kind: "gateway",
    proof: [
      proof("apps/web/app/pay/eps/handle.test.ts", "a hostile query never changes the Location"),
      proof(
        "packages/eps/test/proof-credits-nothing-extra.test.ts",
        "the id of another customer's pending payment, EPS says Pending: nothing changes for anyone",
      ),
    ],
  },
  "app/pay/eps/fail/route.ts": {
    kind: "gateway",
    proof: [
      proof(
        "apps/web/app/pay/eps/handle.test.ts",
        "passes the name of the route as the outcome, and nothing else decides",
      ),
    ],
  },
  "app/pay/eps/cancel/route.ts": {
    kind: "gateway",
    proof: [
      proof(
        "apps/web/app/pay/eps/handle.test.ts",
        "passes the name of the route as the outcome, and nothing else decides",
      ),
    ],
  },

  // ---- pages with an id in the path
  "app/[locale]/(panel)/cdn/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}loaders-tenancy.test.ts`,
        "the loaders of the pages with an id answer another customer's id like a missing row",
      ),
    ],
  },
  "app/[locale]/(panel)/containers/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}loaders-tenancy.test.ts`,
        "the loaders of the pages with an id answer another customer's id like a missing row",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}databases-view.test.ts`,
        "answers null for a missing row, another customer's row, another family and a flag that is off (R8, R12)",
      ),
    ],
  },
  "app/[locale]/(panel)/load-balancers/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}load-balancers-view.test.ts`,
        "answers null for a missing row, another customer's, another family and a flag that is off (R8, R12)",
      ),
    ],
  },
  "app/[locale]/(panel)/orders/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}loaders-tenancy.test.ts`,
        "the loaders of the pages with an id answer another customer's id like a missing row",
      ),
    ],
  },
  "app/[locale]/(panel)/servers/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}loaders-tenancy.test.ts`,
        "the loaders of the pages with an id answer another customer's id like a missing row",
      ),
      proof(
        `${W}extras-view.test.ts`,
        "another customer's server (or a missing one) is empty and the reader is not asked",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}loaders-tenancy.test.ts`,
        "the loaders of the pages with an id answer another customer's id like a missing row",
      ),
    ],
  },
  "app/[locale]/(panel)/wallet/topup/[paymentId]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}loaders-tenancy.test.ts`,
        "the loaders of the pages with an id answer another customer's id like a missing row",
      ),
    ],
  },
};
