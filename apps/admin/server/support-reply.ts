// No `support_reply` template exists in @tc/notify yet (JOURNEY: Needs decision). While this is false,
// replyByEmail refuses before it writes anything (R16) and the screen says so, instead of marking a
// request answered without a message. Switch it on in the same change that registers the template.
export const SUPPORT_REPLY_ENABLED = false;
