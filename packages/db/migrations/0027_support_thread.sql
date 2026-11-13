-- WPU-Z5 (owner decision 2026-11-13, round 3): no support phone and no support e-mail; a support request is a ticket
-- with a thread. Forward-only; 0004 and 0006 are untouched. The first entry of a thread stays support_requests.message;
-- support_messages holds the replies after it (customer, visitor or admin). One new table: Section 7 of the plan names
-- 37 tables, this is the 38th by owner decision (packages/db/test/spec-sync.test.ts names it).
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"admin_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_author_type_check" CHECK ("support_messages"."author_type" in ('customer', 'visitor', 'admin')),
	CONSTRAINT "support_messages_admin_check" CHECK (("support_messages"."author_type" = 'admin') = ("support_messages"."admin_id" IS NOT NULL)),
	CONSTRAINT "support_messages_body_check" CHECK (char_length("support_messages"."body") between 1 and 5000)
);
--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_request_id_support_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."support_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_messages_request_id_created_at_idx" ON "support_messages" USING btree ("request_id","created_at");--> statement-breakpoint
-- The states of a request: open (waits for support), answered (waits for the requester), closed. The named check of
-- 0004 is replaced; every stored row is open or closed, so the new check holds for all of them.
ALTER TABLE "support_requests" DROP CONSTRAINT "support_requests_status_check";--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_status_check" CHECK ("support_requests"."status" in ('open', 'answered', 'closed'));--> statement-breakpoint
-- The time of the last message of the thread. A request stored before this migration has no reply in the thread
-- (a reply was an e-mail only), so its last activity is the time it was sent.
ALTER TABLE "support_requests" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "support_requests" SET "last_activity_at" = "created_at";--> statement-breakpoint
-- Grants, least privilege. web_rw (the customer panel) reads the thread without the admin of a message, adds a
-- customer message (admin_id is not granted, so the check refuses an admin message), and sets the status and the
-- last activity of its own request (the repository scopes every statement by the customer, R8). It reads
-- last_activity_at for the list. admin_rw reads the thread, adds an admin message, and moves the last activity (it
-- keeps SELECT and UPDATE (status, handled_by) of 0006). worker_rw and report_ro get nothing. No DELETE anywhere.
GRANT SELECT (id, request_id, author_type, body, created_at) ON support_messages TO web_rw;--> statement-breakpoint
GRANT INSERT (id, request_id, author_type, body) ON support_messages TO web_rw;--> statement-breakpoint
GRANT SELECT (last_activity_at) ON support_requests TO web_rw;--> statement-breakpoint
GRANT UPDATE (status, last_activity_at) ON support_requests TO web_rw;--> statement-breakpoint
GRANT SELECT ON support_messages TO admin_rw;--> statement-breakpoint
GRANT INSERT (id, request_id, author_type, admin_id, body) ON support_messages TO admin_rw;--> statement-breakpoint
GRANT UPDATE (last_activity_at) ON support_requests TO admin_rw;
