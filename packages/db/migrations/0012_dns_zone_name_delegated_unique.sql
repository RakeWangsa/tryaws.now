-- WPU-S1: replaces the index of 0011. A hosted zone is harmless until the domain's NS records delegate to it
-- (Route 53 allows several zones with one name), so only a DELEGATED zone is exclusive for a name. Several
-- customers may hold an undelegated (pending) zone for one name; a removed or failed zone gives the name back.
-- Forward-only. 0011 stays as it is on main.
DROP INDEX "dns_zones_name_live_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "dns_zones_name_delegated_unique" ON "dns_zones" USING btree ("name") WHERE "dns_zones"."status" = 'delegated';
