-- WPU-G6: a DNS zone is created by an order now. One live zone for a name on the whole platform (a failed
-- or removed zone gives the name back), and a closed list of status words (the same as DNS_ZONE_STATES of
-- packages/core/dns). Forward-only. No row exists before this migration: nothing created dns_zones rows.
CREATE UNIQUE INDEX "dns_zones_name_live_unique" ON "dns_zones" USING btree ("name") WHERE "dns_zones"."status" not in ('removed', 'failed');--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_status_check" CHECK ("dns_zones"."status" in ('pending', 'pending_delegation', 'delegated', 'removing', 'removed', 'failed'));
