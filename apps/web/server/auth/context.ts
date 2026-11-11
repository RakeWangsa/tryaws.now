import type { Clock } from "@tc/core";
import { productionPorts } from "../auth-ports.ts";
import type { WebRuntime } from "../runtime.ts";
import type { AuthPorts } from "./ports.ts";
import { clientIpOf, requestId } from "../request.ts";

// Everything an action core needs from the request, read once. The client address comes only from
// CloudFront-Viewer-Address (clientIpOf): x-forwarded-for is never read, a client can forge it (R9).
export interface ActionContext {
  headers: Headers;
  runtime: WebRuntime;
  clock: Clock;
  /** Eight hex characters a customer can quote from an error state. */
  ref: string;
  /** null = no usable viewer address: the action refuses before any limiter or provider call (R16). */
  ip: string | null;
  /** The database and session side effects; production wiring unless a test passes its own. */
  ports: AuthPorts;
}

export function actionContext(
  headers: Headers,
  runtime: WebRuntime,
  clock: Clock = { now: () => new Date() },
  ports: AuthPorts = productionPorts(runtime, clock),
): ActionContext {
  return {
    headers,
    runtime,
    clock,
    ref: requestId(),
    ip: clientIpOf(headers, runtime.config),
    ports,
  };
}
