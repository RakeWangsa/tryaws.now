import { InMemoryEps } from "@tc/eps";
import type { EpsGateway, InitializeRequest, InitializeResult, VerifyResult } from "@tc/eps";

// Development and test only. Loaded by one literal dynamic import in ../runtime.ts, and only when
// the configuration says fakes (config.ts refuses that in staging and production). The in-memory
// EPS is refused outside development and test by its own constructor, a second guard.

export interface DevEps {
  /** What the payment services talk to: answers a path of the dev checkout instead of the EPS host. */
  gateway: EpsGateway;
  /** The in-memory EPS behind it: the dev checkout route settles a payment here. */
  fake: InMemoryEps;
  /** The `data` of a dev checkout URL -> the merchantTransactionId it stands for. */
  byData: Map<string, string>;
}

const KEY = "__tcDevEps";

function create(): DevEps {
  const fake = new InMemoryEps();
  const byData = new Map<string, string>();
  const gateway: EpsGateway = {
    async initialize(req: InitializeRequest): Promise<InitializeResult> {
      const answer = await fake.initialize(req);
      if (!answer.ok) return answer;
      const data = new URL(answer.redirectUrl).searchParams.get("data");
      if (data === null) return { ok: false, reason: "unavailable" };
      byData.set(data, req.merchantTransactionId);
      return {
        ok: true,
        redirectUrl: `/dev/eps/checkout?data=${encodeURIComponent(data)}`,
        gatewayTransactionId: answer.gatewayTransactionId,
      };
    },
    verify(merchantTransactionId: string): Promise<VerifyResult> {
      return fake.verify(merchantTransactionId);
    },
  };
  return { gateway, fake, byData };
}

/** One per process, kept on globalThis so the route handlers of the dev checkout see the same state. */
export function getDevEps(): DevEps {
  const holder = globalThis as unknown as Record<string, DevEps | undefined>;
  const existing = holder[KEY];
  if (existing !== undefined) return existing;
  const made = create();
  holder[KEY] = made;
  return made;
}
