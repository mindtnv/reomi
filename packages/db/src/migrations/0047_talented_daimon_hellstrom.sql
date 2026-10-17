ALTER TABLE "sources" ADD COLUMN "doc_version" text;--> statement-breakpoint
ALTER TABLE "topic_modules" ADD COLUMN "reference_catalog" jsonb;