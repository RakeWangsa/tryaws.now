import { kycDocumentParams } from "./schemas.ts";
import type { AdminActor, AdminRepos } from "@tc/db";

// The document viewer of 16.12: the image of a KYC document is shown through a short-lived presigned
// URL, never cached. The S3 presigner sits behind a port; the real one is a manual VERIFY (it needs
// the kyc bucket and a role that may read it), so this file holds the port, a refusing default and a
// fake for tests. Nothing here imports packages/aws (R1).

export const KYC_URL_TTL_SECONDS = 60;

export interface KycDocumentStore {
  // The URL that reads one object for ttlSeconds. It may throw; the caller then fails closed.
  presignRead(key: string, ttlSeconds: number): Promise<string>;
}

// The default until the real presigner is wired: every view is refused (R16).
export const unavailableKycStore: KycDocumentStore = {
  presignRead: async () => {
    throw new Error("kyc document store: not configured");
  },
};

// For tests: a URL that names the key and the lifetime, and the list of calls.
export function fakeKycDocumentStore(): KycDocumentStore & {
  readonly calls: { key: string; ttlSeconds: number }[];
} {
  const calls: { key: string; ttlSeconds: number }[] = [];
  return {
    calls,
    presignRead: async (key, ttlSeconds) => {
      calls.push({ key, ttlSeconds });
      return `https://kyc-store.invalid/${encodeURIComponent(key)}?expires=${ttlSeconds}`;
    },
  };
}

export interface KycDocumentRequest {
  readonly submissionId: unknown;
  readonly index: unknown;
  // R10: the short reason the admin gives for looking at the document.
  readonly reason: unknown;
}

export type KycDocumentAnswer =
  | { readonly status: 302; readonly location: string; readonly headers: Record<string, string> }
  | { readonly status: 400 | 403 | 404 | 429 | 503; readonly headers: Record<string, string> };

export interface KycDocumentDeps {
  // requireAdmin(["support", "ops", "superadmin"]).
  readonly authorize: () => Promise<AdminActor>;
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  readonly store: KycDocumentStore;
  readonly clock: { now(): Date };
}

// Neither the browser nor a proxy may keep the answer, and the URL must not leak in a referrer.
const NO_CACHE: Record<string, string> = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
};

// R9 in order: authenticate and authorize, validate (the ids and the reason of R10), rate limit,
// execute (the audit row of the view, with that reason, is written by the repository inside the
// transaction, before the URL exists), answer. Every refusal has
// the same no-store headers and no body text.
export function makeKycDocumentHandler(
  deps: KycDocumentDeps,
): (request: KycDocumentRequest) => Promise<KycDocumentAnswer> {
  return async (request) => {
    const { submissionId, index: rawIndex, reason } = request;
    let actor: AdminActor;
    try {
      actor = await deps.authorize();
    } catch {
      return { status: 403, headers: NO_CACHE };
    }
    try {
      const params = kycDocumentParams.safeParse({ submissionId, index: rawIndex, reason });
      if (!params.success) return { status: 400, headers: NO_CACHE };
      const index = params.data.index;
      const documentSubmissionId = params.data.submissionId;
      if (!(await deps.limiter(actor, deps.clock.now()))) {
        return { status: 429, headers: NO_CACHE };
      }
      const read = await deps.run(actor, (repos) =>
        repos.customers.documentRead(
          { submissionId: documentSubmissionId, index },
          params.data.reason,
        ),
      );
      if (!read.ok) {
        if (read.error === "forbidden") return { status: 403, headers: NO_CACHE };
        if (read.error === "validation") return { status: 400, headers: NO_CACHE };
        return { status: 404, headers: NO_CACHE };
      }
      const location = await deps.store.presignRead(read.value.key, KYC_URL_TTL_SECONDS);
      return { status: 302, location, headers: NO_CACHE };
    } catch {
      return { status: 503, headers: NO_CACHE };
    }
  };
}
