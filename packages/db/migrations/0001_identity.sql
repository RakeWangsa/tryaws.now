CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cognito_sub" text NOT NULL,
	"sessions_valid_after" timestamp with time zone,
	"email" text NOT NULL,
	"phone" text,
	"phone_verified_at" timestamp with time zone,
	"name" text,
	"type" text,
	"kyc_status" text DEFAULT 'none' NOT NULL,
	"risk_tier" text DEFAULT 'new' NOT NULL,
	"market" text NOT NULL,
	"locale" text DEFAULT 'bn' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_cognito_sub_unique" UNIQUE("cognito_sub"),
	CONSTRAINT "customers_type_check" CHECK ("customers"."type" in ('individual', 'business')),
	CONSTRAINT "customers_kyc_status_check" CHECK ("customers"."kyc_status" in ('none', 'pending', 'verified', 'rejected')),
	CONSTRAINT "customers_risk_tier_check" CHECK ("customers"."risk_tier" in ('new', 'trusted')),
	CONSTRAINT "customers_locale_check" CHECK ("customers"."locale" in ('bn', 'en')),
	CONSTRAINT "customers_status_check" CHECK ("customers"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "kyc_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_number_encrypted" "bytea" NOT NULL,
	"s3_keys" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_submissions_s3_keys_check" CHECK (cardinality("kyc_submissions"."s3_keys") >= 1),
	CONSTRAINT "kyc_submissions_status_check" CHECK ("kyc_submissions"."status" in ('pending', 'verified', 'rejected')),
	CONSTRAINT "kyc_submissions_review_check" CHECK ("kyc_submissions"."status" = 'pending' OR ("kyc_submissions"."reviewer_id" IS NOT NULL AND "kyc_submissions"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_acceptances_document_check" CHECK ("legal_acceptances"."document" in ('terms', 'acceptable_use', 'privacy', 'refund', 'domain_registration'))
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenges_attempts_check" CHECK ("otp_challenges"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limits_scope_key_window_start_unique" UNIQUE("scope_key","window_start"),
	CONSTRAINT "rate_limits_count_check" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_keys_customer_id_fingerprint_unique" UNIQUE("customer_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_market_markets_code_fk" FOREIGN KEY ("market") REFERENCES "public"."markets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_reviewer_id_admin_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kyc_submissions_customer_id_idx" ON "kyc_submissions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "legal_acceptances_customer_id_document_idx" ON "legal_acceptances" USING btree ("customer_id","document");--> statement-breakpoint
CREATE INDEX "otp_challenges_customer_id_created_at_idx" ON "otp_challenges" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_idx" ON "rate_limits" USING btree ("window_start");