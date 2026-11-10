CREATE TABLE "customer_homes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"region" text NOT NULL,
	"pool_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_homes_customer_id_region_unique" UNIQUE("customer_id","region")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"enqueue_seq" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"needs_approval" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "operations_state_check" CHECK ("operations"."state" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'needs_approval', 'needs_attention')),
	CONSTRAINT "operations_attempts_check" CHECK ("operations"."attempts" >= 0),
	CONSTRAINT "operations_enqueue_seq_check" CHECK ("operations"."enqueue_seq" >= 0),
	CONSTRAINT "operations_needs_approval_state_check" CHECK ("operations"."state" <> 'needs_approval' OR "operations"."needs_approval"),
	CONSTRAINT "operations_approved_by_check" CHECK ("operations"."approved_by" IS NULL OR "operations"."needs_approval"),
	CONSTRAINT "operations_unapproved_state_check" CHECK (NOT "operations"."needs_approval" OR "operations"."approved_by" IS NOT NULL OR "operations"."state" IN ('needs_approval', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "pool_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aws_account_id" text NOT NULL,
	"name" text NOT NULL,
	"tier" text NOT NULL,
	"role_arn" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_accounts_aws_account_id_unique" UNIQUE("aws_account_id"),
	CONSTRAINT "pool_accounts_name_unique" UNIQUE("name"),
	CONSTRAINT "pool_accounts_aws_account_id_check" CHECK ("pool_accounts"."aws_account_id" ~ '^[0-9]{12}$')
);
--> statement-breakpoint
CREATE TABLE "pool_capacity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pool_account_id" uuid NOT NULL,
	"region" text NOT NULL,
	"quota_code" text NOT NULL,
	"quota_limit" integer NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_capacity_pool_account_id_region_quota_code_unique" UNIQUE("pool_account_id","region","quota_code"),
	CONSTRAINT "pool_capacity_quota_code_check" CHECK ("pool_capacity"."quota_code" in ('instance_vcpu', 'static_ip', 'database', 'load_balancer', 'container_service', 'certificate_active', 'certificate_365d', 'disk_gb', 'bucket', 'distribution')),
	CONSTRAINT "pool_capacity_quota_limit_check" CHECK ("pool_capacity"."quota_limit" >= 0),
	CONSTRAINT "pool_capacity_used_check" CHECK ("pool_capacity"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"family" text NOT NULL,
	"product_id" uuid,
	"pool_account_id" uuid,
	"region" text,
	"aws_name" text,
	"state" text DEFAULT 'creating' NOT NULL,
	"parent_resource_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_aws_name_unique" UNIQUE("aws_name"),
	CONSTRAINT "resources_state_check" CHECK ("resources"."state" in ('creating', 'active', 'stopped', 'suspended', 'destroyed', 'failed')),
	CONSTRAINT "resources_deleted_check" CHECK (("resources"."state" = 'destroyed') = ("resources"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"term_days" integer NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_resource_id_unique" UNIQUE("resource_id"),
	CONSTRAINT "subscriptions_term_days_check" CHECK ("subscriptions"."term_days" > 0),
	CONSTRAINT "subscriptions_period_check" CHECK ("subscriptions"."period_end" > "subscriptions"."period_start"),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('active', 'grace', 'retained', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_resource_id_metric_period_unique" UNIQUE("resource_id","metric","period"),
	CONSTRAINT "usage_records_period_check" CHECK (length("usage_records"."period") > 0),
	CONSTRAINT "usage_records_quantity_check" CHECK ("usage_records"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_homes" ADD CONSTRAINT "customer_homes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_homes" ADD CONSTRAINT "customer_homes_pool_account_id_pool_accounts_id_fk" FOREIGN KEY ("pool_account_id") REFERENCES "public"."pool_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_approved_by_admin_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_capacity" ADD CONSTRAINT "pool_capacity_pool_account_id_pool_accounts_id_fk" FOREIGN KEY ("pool_account_id") REFERENCES "public"."pool_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_pool_account_id_pool_accounts_id_fk" FOREIGN KEY ("pool_account_id") REFERENCES "public"."pool_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_parent_resource_id_resources_id_fk" FOREIGN KEY ("parent_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operations_resource_id_idx" ON "operations" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "operations_state_next_run_at_idx" ON "operations" USING btree ("state","next_run_at");--> statement-breakpoint
CREATE INDEX "resources_customer_id_idx" ON "resources" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "resources_parent_resource_id_idx" ON "resources" USING btree ("parent_resource_id");--> statement-breakpoint
CREATE INDEX "subscriptions_customer_id_idx" ON "subscriptions" USING btree ("customer_id");