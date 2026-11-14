// cognito-messages: the custom message trigger of the customer and the admin pool (see handler.ts), and,
// as its own Lambda (CognitoPreSignUp), the pre sign-up guard of the customer pool (WPU-X12, guard.ts).
// Round 3: both read the id of the server-only sign-up client and the customer pool id from SSM
// (config.ts, ssm.ts) when a decision needs them, once per container. Round 4: an event from a client
// other than the kept one asks for one more read (at most one a minute), so a replaced client is
// recognised without recycling the containers.
export { customMessage, localeOf } from "./handler";
export type { CustomMessageEvent } from "./handler";
export { preSignUpDecision } from "./guard";
export type { PreSignUpEvent } from "./guard";
import { guardConfigLoader, type GuardConfig, type LoadGuardConfig } from "./config";
import { preSignUpDecision, type PreSignUpEvent } from "./guard";
import { GUARDED_SOURCES, customMessage, type CustomMessageEvent } from "./handler";
import { ssmReadParameters } from "./ssm";

// A load that throws is a refusal (null), never an allowance (R16).
async function safely(load: LoadGuardConfig, seen?: string): Promise<GuardConfig | null> {
  try {
    return await load(seen);
  } catch {
    return null;
  }
}

// The client id of an event that may be malformed (a malformed event is refused downstream).
const clientOf = (event: unknown): string | undefined => {
  if (typeof event !== "object" || event === null) return undefined;
  const context = (event as { callerContext?: unknown }).callerContext;
  if (typeof context !== "object" || context === null) return undefined;
  const id = (context as { clientId?: unknown }).clientId;
  return typeof id === "string" ? id : undefined;
};

/** The two handlers over a configuration loader; the tests hand in their own. */
export function makeHandlers(load: LoadGuardConfig) {
  return {
    handler: async (event: CustomMessageEvent): Promise<CustomMessageEvent> => {
      const guarded =
        typeof event === "object" &&
        event !== null &&
        typeof event.triggerSource === "string" &&
        GUARDED_SOURCES.has(event.triggerSource);
      let config = guarded ? await safely(load) : null;
      // A client that is not the kept one may be a replaced client: ask for a fresh read (the loader
      // keeps the cap). Only where the client matters: sign-up and resend on any pool, a reset on the
      // customer pool; the admin pool's own clients never count.
      const seen = clientOf(event);
      if (
        config !== null &&
        seen !== undefined &&
        seen !== config.signUpClientId &&
        (event.triggerSource !== "CustomMessage_ForgotPassword" ||
          event.userPoolId === config.customerPoolId)
      ) {
        config = await safely(load, seen);
      }
      try {
        return customMessage(event, config);
      } catch (error) {
        throw error instanceof Error ? error : new Error("cognito-messages: failed");
      }
    },
    preSignUp: async (event: PreSignUpEvent): Promise<PreSignUpEvent> => {
      let config = await safely(load);
      const seen = clientOf(event);
      if (
        config !== null &&
        seen !== undefined &&
        seen !== config.signUpClientId &&
        event.triggerSource === "PreSignUp_SignUp"
      ) {
        config = await safely(load, seen);
      }
      try {
        return preSignUpDecision(event, config?.signUpClientId ?? null);
      } catch {
        throw new Error("cognito-presignup: sign-up is not allowed");
      }
    },
  };
}

const live = makeHandlers(guardConfigLoader(process.env, ssmReadParameters()));

export const handler = live.handler;
export const preSignUp = live.preSignUp;
