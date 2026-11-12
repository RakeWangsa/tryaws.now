-- WPU-B2. Forward-only. One active order for a domain name on the platform (a failed order gives the name back)
-- and a closed list of status words. Domain flag is off in production (R12), so no row exists there that could clash.
CREATE UNIQUE INDEX "domains_name_active_unique" ON "domains" USING btree ("name") WHERE "domains"."status" <> 'failed';--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_status_check" CHECK ("domains"."status" in ('pending', 'review', 'awaiting_verification', 'registered', 'failed', 'expired'));