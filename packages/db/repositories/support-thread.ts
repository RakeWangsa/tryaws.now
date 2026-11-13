import { SUPPORT_AUTHOR_TYPES, SUPPORT_MESSAGE_MAX, SUPPORT_STATUSES } from "../schema/service";

// WPU-Z5: what the customer side and the admin side of the support thread share. The thread of a request is
// its own text (support_requests.message, the first entry) and the replies in support_messages after it.

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportAuthorType = (typeof SUPPORT_AUTHOR_TYPES)[number];

// The most replies one read of a thread returns: the latest ones, shown oldest first, with a flag when
// earlier replies exist. A thread is read whole in practice; the cap keeps one page bounded.
export const SUPPORT_THREAD_LIMIT = 200;

// The text of a message as it is stored and sent: a browser sends a textarea with CRLF line ends, so CRLF
// becomes LF; then it is trimmed. Null for anything that is not text, or that is empty or longer than
// SUPPORT_MESSAGE_MAX after that (the CHECK of support_messages.body counts characters, which are never
// more than the UTF-16 units counted here).
export function messageBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replaceAll("\r\n", "\n").trim();
  return text.length >= 1 && text.length <= SUPPORT_MESSAGE_MAX ? text : null;
}

// The rows of a thread read latest first with SUPPORT_THREAD_LIMIT + 1 as the limit, as a page: at most
// SUPPORT_THREAD_LIMIT replies, oldest first, and whether earlier ones were left out.
export function threadPage<T>(latestFirst: readonly T[]): { messages: T[]; hasEarlier: boolean } {
  return {
    messages: latestFirst.slice(0, SUPPORT_THREAD_LIMIT).reverse(),
    hasEarlier: latestFirst.length > SUPPORT_THREAD_LIMIT,
  };
}
