CREATE TABLE "browser_captures" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"content_key" text NOT NULL,
	"source_id" uuid,
	"source_fingerprint" text NOT NULL,
	"mode" text NOT NULL,
	"quote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" DROP CONSTRAINT "personal_access_tokens_scope_check";--> statement-breakpoint
ALTER TABLE "browser_captures" ADD CONSTRAINT "browser_captures_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_captures" ADD CONSTRAINT "browser_captures_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_captures_request_uq" ON "browser_captures" USING btree ("user_id","request_key");--> statement-breakpoint
CREATE INDEX "browser_captures_content_idx" ON "browser_captures" USING btree ("user_id","content_key");--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_scope_check" CHECK ("personal_access_tokens"."scope" in ('read', 'write', 'capture'));