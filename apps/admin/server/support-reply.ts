// WPU-D4: the `support_reply` template exists in @tc/notify (packages/notify/templates, tested in
// packages/notify/test/wpu-d4-templates.test.ts and wpu-d4-wiring.test.ts), so replyByEmail writes its
// row and the notifier sends it. WPU-Z5: the reply is first a message of the thread of the request
// (support_messages) and the request becomes `answered`; the mail tells a customer that the reply waits in
// the panel, and gives a visitor the text (packages/notify/test/wpu-z5-support-reply.test.ts). A bounce or
// a refusal of the address is not handled yet (JOURNEY WPU-D4 Needs decision).
export const SUPPORT_REPLY_ENABLED = true;
