# Customer authenticator (TOTP) reset

Section M: "customer sign-in help". WPU-X11. Rules R10, R14, R16.

A customer buys only with a verified e-mail, a verified mobile number and an authenticator app switched on. Cognito keeps the real setting. The platform keeps a copy, `customers.totp_enabled_at`, because the purchase code in `packages/core` cannot call Cognito. The copy is cleared by the platform itself whenever it sees that Cognito says the authenticator is off; this page is for the support steps that change the Cognito setting from outside the panel, and it tells what clears the copy.

## Trigger

A customer has lost the phone with the authenticator app, or asks support to switch the authenticator off, or a support colleague must call `AdminSetUserMFAPreference` for the customer's user in the customer pool.

## Who

Support with the superadmin role, with the control-plane role of the stage (never a long-lived key). The customer is identified by the verified e-mail of the request and a second proof you agree on with the owner (for example an SMS code to the verified phone number). Without that proof nothing is reset: a reset is how an attacker takes an account.

## Safe checks

1. The request comes from the e-mail address of the account and from the support page, not from a forwarded message.
2. Look at the audit rows of the customer on `/customers/[id]`: a recent `auth.totp_drift` row means the authenticator was already switched off outside the panel, and the request may follow a theft.
3. Ask for the second proof. A customer who cannot give it waits; do not reset to be kind.

## Steps

1. Switch the authenticator off at Cognito for that user: `AdminSetUserMFAPreference` with the software token disabled.
2. End the sessions of the user at Cognito: `AdminUserGlobalSignOut`. A refresh token from before stops working; an access token that was already issued is refused by the purchase check below.
3. The platform copy `customers.totp_enabled_at` is cleared by the platform, not by hand, at the first of these: the customer's next sign-in (the tokens come without the authenticator challenge, so the sign-in clears the copy and writes the audit row `auth.totp_drift`), or the next draft or purchase (it asks Cognito for the setting of the session's user with GetUser, refuses when the authenticator is off or the answer cannot be had, and clears the copy). Until then the core still sees the old copy, but no draft or purchase passes without the Cognito check. There is no admin action that writes `totp_enabled_at` directly; do not edit the database by hand.
4. Tell the customer: the account has no authenticator now, buying is blocked, and they switch it on again in Settings, Security after they sign in with the password.

## Rollback

There is none for a wrong reset except to switch the authenticator on again with the customer, who must have a fresh sign-in. If the reset was a mistake of ours, say so in the ticket and tell the owner.

## Log

Customer id, the ticket, who did the reset, which proof was used (the word, not the value), the time. Never the secret key, an authenticator code, a token or the phone number (R14).

## Must not

Reset on the word of a chat message or a forwarded e-mail alone; switch the authenticator off at Cognito and consider the job done without telling the customer; read or ask for the secret key or a code of the app; keep a copy of any code or key in a ticket; change `customers` by hand to clear the copy.
