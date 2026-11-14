// cognito-messages: the custom message trigger of the customer and the admin pool (see handler.ts), and,
// as its own Lambda (CognitoPreSignUp), the pre sign-up guard of the customer pool (WPU-X12, guard.ts).
// Round 3: both read the id of the server-only sign-up client and the customer pool id from SSM
// (config.ts, ssm.ts) when a decision needs them, once per container.
export { customMessage, localeOf } from "./handler";
export type { CustomMessageEvent } from "./handler";
export { preSignUpDecision } from "./guard";
export type { PreSignUpEvent } from "./guard";
import { guardConfigLoader, type GuardConfig, type LoadGuardConfig } from "./config";
import { preSignUpDecision, type PreSignUpEvent } from "./guard";
import { GUARDED_SOURCES, customMessage, type CustomMessageEvent } from "./handler";
import { ssmReadParameters } from "./ssm";

// A load that throws is a refusal (null), never an allowance (R16).
async function safely(load: LoadGuardConfig): Promise<GuardConfig | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** The two handlers over a configuration loader; the tests hand in their own. */
export function makeHandlers(load: LoadGuardConfig) {
  return {
    handler: async (event: CustomMessageEvent): Promise<CustomMessageEvent> => {
      const guarded =
        typeof event === "object" &&
        event !== null &&
        typeof event.triggerSource === "string" &&
        GUARDED_SOURCES.has(event.triggerSource);
      const config = guarded ? await safely(load) : null;
      try {
        return customMessage(event, config);
      } catch (error) {
        throw error instanceof Error ? error : new Error("cognito-messages: failed");
      }
    },
    preSignUp: async (event: PreSignUpEvent): Promise<PreSignUpEvent> => {
      const config = await safely(load);
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
