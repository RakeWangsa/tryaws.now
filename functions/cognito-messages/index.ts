// cognito-messages: the custom message trigger of the customer and the admin pool (see handler.ts).
export { customMessage, localeOf } from "./handler";
export type { CustomMessageEvent } from "./handler";
import { customMessage, type CustomMessageEvent } from "./handler";

export const handler = (event: CustomMessageEvent): Promise<CustomMessageEvent> => {
  try {
    return Promise.resolve(customMessage(event));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("cognito-messages: failed"));
  }
};
