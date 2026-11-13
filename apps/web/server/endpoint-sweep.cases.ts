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
const SERVER_OPS = proof(
  `${W}server-actions.test.ts`,
  "every action on an unknown id is not_found and writes nothing",
);
const AUTO_RENEW = proof(
  `${W}auto-renew-actions.test.ts`,
  "R8: another customer's %s, or none, is not_found, and nothing is written, audited or counted",
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
// Security review 2 (R8): the real-database proof of the access-details function for the three actions
// beyond the Windows password. B asks for A's resource, gets the answer of a missing id, and AWS is
// never called (functions/access-details/test/proof-cross-tenant.test.ts; it runs where PostgreSQL is).
const ACCESS_DETAILS_REAL_DB = proof(
  "functions/access-details/test/proof-cross-tenant.test.ts",
  "R8: %s, customer B against customer A",
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
      ACCESS_DETAILS_REAL_DB,
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
  // WPU-Z14: the auto-renew switch of every family with no switch of its own; one Server Action per family
  // (the family is fixed in the action). Another customer's row and a missing one are one answer that writes,
  // audits and counts nothing (R8); the session is read first and the form's customerId is ignored (R9).
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setWindowsAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setDiskAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setDatabaseAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setBucketAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setLoadBalancerAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setContainerAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setCdnAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/_family/auto-renew-actions.ts#setDnsZoneAutoRenewAction": {
    kind: "id",
    proof: [AUTO_RENEW],
  },
  "app/[locale]/(panel)/domains/[name]/actions.ts#setDomainAutoRenewAction": {
    kind: "id",
    proof: [
      proof(
        `${W}domain-actions.test.ts`,
        "answers not_found for another customer's domain and flag_off with the flag off",
      ),
    ],
  },
  // WPU-B2: the two domain actions that write an operation row for Route 53 Domains. The domain of another
  // customer is one answer with a missing one and nothing is written (R8); the session is read first (R9).
  "app/[locale]/(panel)/domains/[name]/actions.ts#resendVerificationAction": {
    kind: "id",
    proof: [
      proof(
        `${W}domain-ops.test.ts`,
        "another customer's domain and a missing one are one answer; nothing is written (R8)",
      ),
      proof(`${W}domain-ops.test.ts`, "refuses without a session before anything is read"),
    ],
  },
  "app/[locale]/(panel)/domains/[name]/actions.ts#setNameServersAction": {
    kind: "id",
    proof: [
      proof(
        `${W}domain-ops.test.ts`,
        "another customer's domain, flag off, a busy domain and a domain that is not registered",
      ),
      proof(
        `${W}domain-ops.test.ts`,
        "needs the typed name (second confirmation) and a valid list, before the store",
      ),
    ],
  },
  // WPU-G4: the DNS record editor. R9 order, the zone of another customer is one answer with a missing
  // one, the flag, the busy zone and the idempotency key are all in dns-actions.test.ts.
  "app/[locale]/(panel)/dns/[id]/actions.ts#saveRecordAction": {
    kind: "id",
    proof: [
      proof(
        `${W}dns-actions.test.ts`,
        "another customer's zone answers like a missing zone and writes nothing",
      ),
      proof(
        `${W}dns-actions.test.ts`,
        "adds a record in that order and queues one change_dns_record operation",
      ),
    ],
  },
  "app/[locale]/(panel)/dns/[id]/actions.ts#deleteRecordAction": {
    kind: "id",
    proof: [
      proof(
        `${W}dns-actions.test.ts`,
        "another customer's zone answers like a missing zone and writes nothing",
      ),
      proof(
        `${W}dns-actions.test.ts`,
        "delete needs an existing set and sends only the name and the type",
      ),
    ],
  },
  // WPU-G6: the DNS zone create form and the delete. The draft acts on the session's customer only; the
  // delete takes a zone id, and another customer's zone answers like a missing one (R8).
  "app/[locale]/(panel)/dns/actions.ts#createDnsZoneDraftAction": {
    kind: "session",
    proof: [
      proof(
        `${W}dns-zone-actions.test.ts`,
        "authenticates, validates, rate limits and drafts, in that order (R9), with the parsed name only",
      ),
      proof(
        `${W}dns-zone-actions.test.ts`,
        "refuses an unauthenticated request before anything else",
      ),
    ],
  },
  "app/[locale]/(panel)/dns/[id]/actions.ts#destroyDnsZoneAction": {
    kind: "id",
    proof: [
      proof(
        `${W}dns-zone-actions.test.ts`,
        "another customer's zone, a missing one and another family are one answer, and nothing is written (R8)",
      ),
      proof(
        `${W}dns-zone-actions.test.ts`,
        "needs a fresh sign-in (U10), the exact zone name, then queues the destroy for approval (R13), in R9 order",
      ),
    ],
  },
  "app/[locale]/(panel)/domains/new/actions.ts#createDomainDraftAction": {
    kind: "session",
    proof: [
      proof(
        `${W}domain-actions.test.ts`,
        "refuses a name outside the sellable TLDs and an anonymous caller",
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
  "app/[locale]/(panel)/load-balancers/[id]/actions.ts#setLoadBalancerAttributesAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions.test.ts`,
        "another customer's row and a missing one give one answer, and nothing is queued (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/load-balancers/[id]/actions.ts#requestCertificateAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions.test.ts`,
        "another customer's row and a missing one give one answer, and nothing is queued (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/load-balancers/[id]/actions.ts#refreshCertificateAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions.test.ts`,
        "another customer's row and a missing one give one answer, and nothing is queued (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/actions.ts#setDatabaseOptionsAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions.test.ts`,
        "another customer's row and a missing one give one answer, and nothing is queued (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/actions.ts#setBucketInstanceAccessAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions-g9.test.ts`,
        "another customer's instance answers like a missing one and queues nothing (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/snapshot-actions.ts#createDbSnapshotAction": {
    kind: "id",
    proof: [
      proof(
        `${W}db-snapshot-actions.test.ts`,
        "another customer's database is not found (R8) and a database not active is not allowed",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/snapshot-actions.ts#deleteDbSnapshotAction": {
    kind: "id",
    proof: [
      proof(
        `${W}db-snapshot-actions.test.ts`,
        "another customer's snapshot is not found (R8); a final snapshot or a snapshot of a server is not allowed",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/snapshot-actions.ts#restoreDatabaseSnapshotAction": {
    kind: "id",
    proof: [
      proof(
        "packages/core/orders/db-restore-order.test.ts",
        "another customer's snapshot answers like a missing one (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/databases/[id]/snapshot-actions.ts#restoreDatabasePointInTimeAction": {
    kind: "id",
    proof: [
      proof(
        "packages/core/orders/db-restore-order.test.ts",
        "another customer's database answers like a missing one (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/storage/[id]/actions.ts#setBucketVersioningAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions.test.ts`,
        "another customer's row and a missing one give one answer, and nothing is queued (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/cdn/[id]/actions.ts#resetCdnCacheAction": {
    kind: "id",
    proof: [
      proof(
        `${W}console-actions.test.ts`,
        "another customer's row and a missing one give one answer, and nothing is queued (R8)",
      ),
    ],
  },
  // WPU-G8: container service and CDN console actions. One proof for all: the table of console-g8-actions.test.ts
  // runs every spec with a foreign id and a missing id and shows one answer and nothing queued.
  ...Object.fromEntries(
    [
      "containers/[id]/actions.ts#scheduleContainerPlanAction",
      "containers/[id]/actions.ts#requestContainerCertificateAction",
      "containers/[id]/actions.ts#refreshContainerCertificateAction",
      "containers/[id]/actions.ts#setContainerEndpointAction",
      "cdn/[id]/actions.ts#setCdnCacheBehaviorsAction",
      "cdn/[id]/actions.ts#setCdnOriginAction",
      "cdn/[id]/actions.ts#scheduleCdnPlanAction",
      "cdn/[id]/actions.ts#requestCdnCertificateAction",
      "cdn/[id]/actions.ts#refreshCdnCertificateAction",
    ].map((name): [string, EndpointEntry] => [
      `app/[locale]/(panel)/${name}`,
      {
        kind: "id",
        proof: [
          proof(
            `${W}console-g8-actions.test.ts`,
            "another customer's row and a missing one give one answer, and nothing is queued (R8)",
          ),
        ],
      },
    ]),
  ),
  // WPU-G11: remove or replace a certificate, and the parameters and reboot of a database. The cross-tenant
  // proof of the table runs every spec with a foreign id and shows the one answer and nothing queued (R8).
  ...Object.fromEntries(
    [
      "load-balancers/[id]/actions.ts#removeCertificateAction",
      "load-balancers/[id]/actions.ts#replaceCertificateAction",
      "containers/[id]/actions.ts#removeContainerCertificateAction",
      "containers/[id]/actions.ts#replaceContainerCertificateAction",
      "cdn/[id]/actions.ts#removeCdnCertificateAction",
      "cdn/[id]/actions.ts#replaceCdnCertificateAction",
    ].map((name): [string, EndpointEntry] => [
      `app/[locale]/(panel)/${name}`,
      {
        kind: "id",
        proof: [
          proof(
            `${W}console-actions-g11.test.ts`,
            "another customer's resource, a missing one and a wrong family give one answer and queue nothing (R8)",
          ),
        ],
      },
    ]),
  ),
  ...Object.fromEntries(
    [
      "databases/[id]/actions.ts#setDatabaseParametersAction",
      "databases/[id]/actions.ts#readDatabaseParametersAction",
      "databases/[id]/actions.ts#rebootDatabaseAction",
    ].map((name): [string, EndpointEntry] => [
      `app/[locale]/(panel)/${name}`,
      {
        kind: "id",
        proof: [
          proof(
            `${W}console-actions-g11.test.ts`,
            "read and reboot answer a foreign or missing database like not found and queue nothing (R8)",
          ),
        ],
      },
    ]),
  ),
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
  // WP9-T4b: the customer comes from the session; the optional related resource is checked against
  // the customer's own rows by the repository (not_found for another customer's, packages/db proof).
  "app/[locale]/(panel)/support/new/actions.ts#createSupportRequestAction": {
    kind: "session",
    proof: [
      proof(
        `${W}support-actions.test.ts`,
        "authenticates, validates, rate limits, writes and audits, in that order (R9)",
      ),
      proof(
        `${W}support-actions.test.ts`,
        "takes the customer from the session, never from the input (R8)",
      ),
      proof(
        "packages/db/test/support-repo.test.ts",
        "a related resource of the customer is stored",
      ),
    ],
  },
  // WPU-Z6: the reply and the close of a support request. The request id comes from the form; the
  // repositories of the session's customer answer another customer's request like a missing one.
  "app/[locale]/(panel)/support/requests/[id]/actions.ts#addSupportMessageAction": {
    kind: "id",
    proof: [
      proof(
        `${W}support-thread-actions.test.ts`,
        "authenticates, validates, rate limits, writes and audits, in that order (R9)",
      ),
      proof(
        `${W}support-thread-actions.test.ts`,
        "cross-tenant: another customer's request answers like a missing one and nothing is audited (R8)",
      ),
      proof(
        "packages/db/test/support-repo.test.ts",
        "addMessage refuses a blank or too long text (validation) and another customer's request (not_found), writing nothing",
      ),
    ],
  },
  "app/[locale]/(panel)/support/requests/[id]/actions.ts#closeSupportRequestAction": {
    kind: "id",
    proof: [
      proof(
        `${W}support-thread-actions.test.ts`,
        "authenticates, validates, rate limits, closes and audits, in that order (R9)",
      ),
      proof(
        `${W}support-thread-actions.test.ts`,
        "cross-tenant: another customer's request answers like a missing one and nothing is audited (R8)",
      ),
      proof(
        "packages/db/test/support-repo.test.ts",
        "close closes the customer's own request once; a second close is a replay; another customer's is not_found",
      ),
    ],
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
  "app/[locale]/(panel)/servers/[id]/actions.ts#addDiskAction": {
    kind: "id",
    proof: [
      proof(
        "packages/core/orders/disk-order.test.ts",
        "another customer's server answers like a missing one (R8)",
      ),
      proof(
        `${W}disk-actions.test.ts`,
        "another customer's server answers like a missing one: the same public answer",
      ),
    ],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#restoreDiskAction": {
    kind: "id",
    proof: [
      proof(
        "packages/core/orders/disk-restore-order.test.ts",
        "another customer's snapshot answers like a missing one and writes nothing (R8)",
      ),
      proof(
        `${W}disk-restore-actions.test.ts`,
        "another customer's snapshot answers like a missing one: the same public answer (R8)",
      ),
    ],
  },
  // WPU-G2: reboot, stop, start, rename, firewall rules and static IP of a server.
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#rebootServerAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#stopServerAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#startServerAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#renameServerAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#addFirewallRuleAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#removeFirewallRuleAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#attachStaticIpAction": {
    kind: "id",
    proof: [SERVER_OPS],
  },
  "app/[locale]/(panel)/servers/[id]/manage-actions.ts#detachStaticIpAction": {
    kind: "id",
    proof: [SERVER_OPS],
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
  "app/[locale]/(panel)/servers/[id]/actions.ts#restoreToNewServerAction": {
    kind: "id",
    proof: [
      proof(
        "packages/core/orders/restore-order.test.ts",
        "another customer's backup answers like a missing one (R8)",
      ),
      proof(`${W}order-actions.test.ts`, "refuses without a session and runs nothing else"),
    ],
  },
  "app/[locale]/(panel)/servers/[id]/actions.ts#renewNowAction": {
    kind: "id",
    proof: [
      proof(
        `${W}extras-actions.test.ts`,
        "another customer's server, or none, is not_found and nothing is charged or audited (R8)",
      ),
      proof(
        "packages/core/lifecycle/renew-now.db.test.ts",
        "another customer's server answers not_found, like a missing one (R8)",
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
        "customer B asking for customer A's server gets the answer of a missing id, and the tenant read ran (R8)",
      ),
    ],
  },
  "app/[locale]/(panel)/servers/new/actions.ts#createOrderDraftAction": {
    kind: "session",
    proof: [
      ORDER_SESSION,
      // WPU-G10: the wizard can also store a public key (made in the browser or pasted).
      proof(
        `${W}wizard-key.test.ts`,
        "the customer id in the form is ignored: the key store and the order use the session",
      ),
      proof(
        `${W}wizard-key.test.ts`,
        "stores the public key through the customer's repository, audits it, and drafts with the new key id",
      ),
      proof(
        `${W}wizard-key.test.ts`,
        "a private key in the public field is refused, never stored, never echoed",
      ),
      proof(`${W}wizard-key.test.ts`, "without a session nothing runs (R16)"),
    ],
  },
  "app/[locale]/(panel)/settings/profile/actions.ts#updateProfileAction": {
    kind: "session",
    proof: [SETTINGS_ORDER],
  },
  // WPU-I3: the billing details. The customer is the session's (R8): the store is opened for the id of the
  // session, the body names no customer, and the repository writes the four columns of that row only.
  "app/[locale]/(panel)/settings/profile/actions.ts#updateBillingAction": {
    kind: "session",
    proof: [
      proof(
        `${W}billing-actions.test.ts`,
        "authenticates, validates, rate limits, writes and audits, in that order",
      ),
      proof(
        `${W}billing-actions.test.ts`,
        "a customer id, an e-mail or a role in the body reaches nothing",
      ),
      proof(
        "packages/db/test/billing-profile.test.ts",
        "one customer's write never touches another customer's row",
      ),
      CUSTOMER_REPOS,
    ],
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
      ACCESS_DETAILS_REAL_DB,
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
  "app/[locale]/(public)/support/actions.ts#publicSupportAction": {
    kind: "public",
    proof: [
      proof(`${W}public/support-form.test.ts`, "is the same answer for a replay (R7)"),
      proof(
        `${W}public/support-form.test.ts`,
        "a filled honeypot answers done, stores nothing and does not use the limiter",
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
        "every legal document is a draft awaiting approval",
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

  // WPU-G4: the printable invoice. A customer's own invoice only; another customer's id is a 404.
  "app/[locale]/(panel)/invoices/[id]/document/route.ts": {
    kind: "id",
    proof: [
      proof(
        `${W}invoice-document.test.ts`,
        "answers 404 for another customer's invoice, like for a missing one (R8)",
      ),
      proof(`${W}invoice-document.test.ts`, "answers 401 without a session and reads nothing (R9)"),
      CUSTOMER_REPOS,
    ],
  },

  // WPU-N1: "Download PDF". The invoice is read for the session's customer; the renderer gets that id.
  "app/[locale]/(panel)/invoices/[id]/pdf/route.ts": {
    kind: "id",
    proof: [
      proof(
        `${W}invoice-pdf.test.ts`,
        "cross-tenant: another customer's invoice answers 404 and the renderer is never called (R8)",
      ),
      proof(`${W}invoice-pdf.test.ts`, "answers 401 without a session and touches nothing (R9)"),
      CUSTOMER_REPOS,
    ],
  },

  // ---- pages with an id in the path
  "app/[locale]/(panel)/invoices/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}invoice-view.test.ts`,
        "answers null for another customer's invoice like for a missing one (R8)",
      ),
      CUSTOMER_REPOS,
    ],
  },
  "app/[locale]/(panel)/dns/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}dns-view.test.ts`,
        "answers null for another customer's zone like for a missing one (R8)",
      ),
      CUSTOMER_REPOS,
    ],
  },
  "app/[locale]/(panel)/domains/[name]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}domain-tenancy.test.ts`,
        "loadDomainDetail opens only the session's repositories, finds nothing and writes nothing",
      ),
    ],
  },
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
      // The page lists the bucket keys through the access-details function (bucketKeyList).
      ACCESS_DETAILS_REAL_DB,
    ],
  },
  "app/[locale]/(panel)/support/requests/[id]/page.tsx": {
    kind: "id",
    proof: [
      proof(
        `${W}support-view.test.ts`,
        "answers null for another customer's request like for a missing one, and writes nothing (R8)",
      ),
      proof(
        "packages/db/test/support-repo.test.ts",
        "thread of another customer's request, a missing one and a malformed id is not_found (R8)",
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
