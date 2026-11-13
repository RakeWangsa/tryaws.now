import { SUPPORT_AUTHOR_TYPES, SUPPORT_MESSAGE_MAX, SUPPORT_STATUSES } from "../schema/service";

// WPU-Z5: what the customer side and the admin side of the support thread share. The thread of a request is
// its own text (support_requests.message, the first entry) and the replies in support_messages after it.

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportAuthorType = (typeof SUPPORT_AUTHOR_TYPES)[number];

// The most replies one read of a thread returns: the latest ones, shown oldest first, with a flag when
// earlier replies exist. A thread is read whole in practice; the cap keeps one page bounded.
export const SUPPORT_THREAD_LIMIT = 200;

// Control characters (a tab too), zero-width characters and the bidirectional overrides that make text
// look like something else: the same code points the notifier refuses in a multiline field
// (packages/notify/templates/data.ts, f.multiline; test/wpu-z5-support-reply.test.ts there pins that both
// agree). A message that holds one is refused before anything is written, so a stored reply can always be
// sent (R16) and no override character reaches a screen. Checked by code point: no control character
// sits in a regular expression.
export function hasForbiddenChar(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

// The text of a message as it is stored and sent: a browser sends a textarea with CRLF line ends, so CRLF
// becomes LF; then it is trimmed. Null for anything that is not text, that is empty or longer than
// SUPPORT_MESSAGE_MAX after that (the CHECK of support_messages.body counts characters, which are never
// more than the UTF-16 units counted here), or that holds a forbidden character other than a line break.
export function messageBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replaceAll("\r\n", "\n").trim();
  return text.length >= 1 &&
    text.length <= SUPPORT_MESSAGE_MAX &&
    !hasForbiddenChar(text.replaceAll("\n", ""))
    ? text
    : null;
}

// The rows of a thread read latest first with SUPPORT_THREAD_LIMIT + 1 as the limit, as a page: at most
// SUPPORT_THREAD_LIMIT replies, oldest first, and whether earlier ones were left out.
export function threadPage<T>(latestFirst: readonly T[]): { messages: T[]; hasEarlier: boolean } {
  return {
    messages: latestFirst.slice(0, SUPPORT_THREAD_LIMIT).reverse(),
    hasEarlier: latestFirst.length > SUPPORT_THREAD_LIMIT,
  };
}
