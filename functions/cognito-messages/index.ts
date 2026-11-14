// cognito-messages: the custom message trigger of the customer and the admin pool (see handler.ts), and,
// as its own Lambda (CognitoPreSignUp), the pre sign-up guard of the customer pool (WPU-X12, guard.ts).
// Both read the id of the server-only sign-up client from SIGN_UP_CLIENT_ID when they run.
export { customMessage, localeOf } from "./handler";
export type { CustomMessageEvent } from "./handler";
export { preSignUpDecision, signUpClientIdFrom } from "./guard";
export type { PreSignUpEvent } from "./guard";
import { preSignUpDecision, signUpClientIdFrom, type PreSignUpEvent } from "./guard";
import { customMessage, type CustomMessageEvent } from "./handler";

export const handler = (event: CustomMessageEvent): Promise<CustomMessageEvent> => {
  try {
    return Promise.resolve(customMessage(event, signUpClientIdFrom(process.env)));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("cognito-messages: failed"));
  }
};

export const preSignUp = (event: PreSignUpEvent): Promise<PreSignUpEvent> => {
  try {
    return Promise.resolve(preSignUpDecision(event, signUpClientIdFrom(process.env)));
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("cognito-presignup: sign-up is not allowed"),
    );
  }
};
