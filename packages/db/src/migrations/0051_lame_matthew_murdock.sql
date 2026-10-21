ALTER TABLE "library_documentation" ADD COLUMN "schedule" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD COLUMN "next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD COLUMN "sync_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD COLUMN "sync_claim_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD COLUMN "sync_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD COLUMN "last_result" jsonb;--> statement-breakpoint
ALTER TABLE "library_documentation_pages" ADD COLUMN "last_change" text;--> statement-breakpoint
CREATE INDEX "library_documentation_due_idx" ON "library_documentation" USING btree ("next_sync_at") WHERE "library_documentation"."schedule" <> 'off';