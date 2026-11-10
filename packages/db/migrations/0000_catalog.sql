CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cognito_sub" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_cognito_sub_unique" UNIQUE("cognito_sub"),
	CONSTRAINT "admin_users_role_check" CHECK ("admin_users"."role" in ('support', 'finance', 'ops', 'superadmin')),
	CONSTRAINT "admin_users_status_check" CHECK ("admin_users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"aws_id" text NOT NULL,
	"platform" text,
	"region" text NOT NULL,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aws_price_usd" numeric(12, 4) NOT NULL,
	"billing_unit" text NOT NULL,
	"feature_flag" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_family_aws_id_region_unique" UNIQUE("family","aws_id","region"),
	CONSTRAINT "catalog_products_aws_price_usd_check" CHECK ("catalog_products"."aws_price_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"market" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_market_unique" UNIQUE("key","market")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"market" text NOT NULL,
	"rate" numeric(12, 6) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_market_effective_from_unique" UNIQUE("market","effective_from"),
	CONSTRAINT "fx_rates_rate_check" CHECK ("fx_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"currency" text NOT NULL,
	"gateway" text NOT NULL,
	"locales" text[] NOT NULL,
	"numerals" text NOT NULL,
	"topup_min_minor" bigint NOT NULL,
	"topup_max_minor" bigint NOT NULL,
	"quick_amounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_code_unique" UNIQUE("code"),
	CONSTRAINT "markets_code_check" CHECK ("markets"."code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "markets_currency_check" CHECK ("markets"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "markets_locales_check" CHECK (cardinality("markets"."locales") >= 1),
	CONSTRAINT "markets_numerals_check" CHECK ("markets"."numerals" in ('beng', 'latn')),
	CONSTRAINT "markets_topup_min_minor_check" CHECK ("markets"."topup_min_minor" > 0),
	CONSTRAINT "markets_topup_range_check" CHECK ("markets"."topup_max_minor" >= "markets"."topup_min_minor"),
	CONSTRAINT "markets_quick_amounts_check" CHECK (jsonb_typeof("markets"."quick_amounts") = 'array')
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"market" text NOT NULL,
	"product_family" text,
	"steps" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_rules_market_product_family_effective_from_unique" UNIQUE NULLS NOT DISTINCT("market","product_family","effective_from"),
	CONSTRAINT "pricing_rules_steps_check" CHECK (jsonb_typeof("pricing_rules"."steps") = 'array')
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"market" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"value" jsonb NOT NULL,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_market_scope_scope_id_unique" UNIQUE NULLS NOT DISTINCT("key","market","scope","scope_id"),
	CONSTRAINT "settings_scope_check" CHECK ("settings"."scope" in ('market', 'tier', 'customer')),
	CONSTRAINT "settings_scope_id_check" CHECK (("settings"."scope" = 'market') = ("settings"."scope_id" is null))
);
--> statement-breakpoint
CREATE TABLE "tlds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tld" text NOT NULL,
	"registration_price_usd" numeric(12, 4),
	"renewal_price_usd" numeric(12, 4),
	"transfer_price_usd" numeric(12, 4),
	"needs_extra_params" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tlds_tld_unique" UNIQUE("tld"),
	CONSTRAINT "tlds_tld_check" CHECK ("tlds"."tld" ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*$')
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_market_markets_code_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_market_markets_code_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_set_by_admin_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_market_markets_code_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_set_by_admin_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_market_markets_code_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_set_by_admin_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;