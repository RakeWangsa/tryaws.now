CREATE TABLE "abuse_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abuse_cases_status_check" CHECK ("abuse_cases"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" in ('customer', 'admin', 'system')),
	CONSTRAINT "audit_log_actor_check" CHECK (("audit_log"."actor_type" = 'system') = ("audit_log"."actor_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "discrepancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discrepancies_kind_check" CHECK ("discrepancies"."kind" in ('orphan', 'missing', 'cost', 'payment')),
	CONSTRAINT "discrepancies_status_check" CHECK ("discrepancies"."status" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "dns_zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hosted_zone_id" text,
	"name_servers" text[] DEFAULT '{}' NOT NULL,
	"delegated_at" timestamp with time zone,
	"status" text NOT NULL,
	"notices_sent_at" timestamp with time zone[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_zones_resource_id_unique" UNIQUE("resource_id"),
	CONSTRAINT "dns_zones_hosted_zone_id_unique" UNIQUE("hosted_zone_id")
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tld" text NOT NULL,
	"route53_operation_id" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"hosted_zone_id" text,
	"registrant_contact_encrypted" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_resource_id_unique" UNIQUE("resource_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid,
	"email" text,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_recipient_check" CHECK ("notifications"."customer_id" IS NOT NULL OR "notifications"."email" IS NOT NULL),
	CONSTRAINT "notifications_channel_check" CHECK ("notifications"."channel" in ('email', 'sms', 'in_app')),
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" in ('pending', 'sent', 'failed')),
	CONSTRAINT "notifications_attempts_check" CHECK ("notifications"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid,
	"name" text,
	"email" text,
	"category" text NOT NULL,
	"related_resource_id" uuid,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"handled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_requests_recipient_check" CHECK ("support_requests"."customer_id" IS NOT NULL OR "support_requests"."email" IS NOT NULL),
	CONSTRAINT "support_requests_status_check" CHECK ("support_requests"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid,
	"email" text,
	"product_family" text NOT NULL,
	"region" text NOT NULL,
	"reason" text NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_recipient_check" CHECK ("waitlist_entries"."customer_id" IS NOT NULL OR "waitlist_entries"."email" IS NOT NULL),
	CONSTRAINT "waitlist_entries_reason_check" CHECK ("waitlist_entries"."reason" in ('capacity', 'flag_off'))
);
--> statement-breakpoint
ALTER TABLE "abuse_cases" ADD CONSTRAINT "abuse_cases_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tld_tlds_tld_fk" FOREIGN KEY ("tld") REFERENCES "public"."tlds"("tld") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_related_resource_id_resources_id_fk" FOREIGN KEY ("related_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_handled_by_admin_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_cases_resource_id_idx" ON "abuse_cases" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_type_actor_id_created_at_idx" ON "audit_log" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_type_target_id_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "dns_zones_customer_id_idx" ON "dns_zones" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "domains_customer_id_idx" ON "domains" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "domains_name_idx" ON "domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "notifications_customer_id_idx" ON "notifications" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "notifications_status_created_at_idx" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "support_requests_customer_id_idx" ON "support_requests" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_customer_id_idx" ON "waitlist_entries" USING btree ("customer_id");