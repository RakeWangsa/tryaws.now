-- WPU-X11. Owner decision 2026-11-14 (chat; quoted verbatim in JOURNEY.md): customers need no KYC, only e-mail
-- and mobile verification and then a 2FA authenticator, because the system is wallet based.
-- The buy condition is now e-mail verified + mobile verified + authenticator (TOTP) on. customers gets two
-- nullable columns that only the server sets: email_verified_at (at a successful sign-in: Cognito signs in
-- confirmed addresses only) and totp_enabled_at (after Cognito accepted the authenticator code and the MFA
-- preference was saved; cleared when the customer switches it off). Nothing of KYC is dropped or changed:
-- customers.kyc_status, kyc_submissions and their grants stay as they are (no data is deleted).
ALTER TABLE "customers" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
-- The web role writes both columns, through the profile repository only (markEmailVerified, setTotpEnabled).
GRANT UPDATE (email_verified_at, totp_enabled_at) ON customers TO web_rw;--> statement-breakpoint
-- A customer who has signed in before this migration has a confirmed address: the earliest sign-in in the
-- audit log is the time it was proven. Only a NULL is filled, so a second run writes nothing (idempotent).
UPDATE customers c
SET email_verified_at = s.first_sign_in
FROM (
  SELECT actor_id, min(created_at) AS first_sign_in
  FROM audit_log
  WHERE actor_type = 'customer' AND action = 'auth.sign_in'
  GROUP BY actor_id
) s
WHERE s.actor_id = c.id AND c.email_verified_at IS NULL;
