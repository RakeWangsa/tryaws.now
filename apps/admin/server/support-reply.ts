// WPU-D4: the `support_reply` template exists in @tc/notify (packages/notify/templates, tested in
// packages/notify/test/wpu-d4-templates.test.ts and wpu-d4-wiring.test.ts), so replyByEmail writes its
// row and the notifier sends it. A bounce or a refusal of the address is not handled yet (JOURNEY
// WPU-D4 Needs decision); the request is marked answered when the row is written, as before.
export const SUPPORT_REPLY_ENABLED = true;
