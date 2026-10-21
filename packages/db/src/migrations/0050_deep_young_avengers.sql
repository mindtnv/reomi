CREATE TABLE "library_documentation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"root_url" text NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"folder_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"manifest" jsonb NOT NULL,
	"selected_prefixes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_folders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "library_documentation_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"section" text NOT NULL,
	"source_id" uuid,
	"imported" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "library_documentation" ADD CONSTRAINT "library_documentation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_documentation" ADD CONSTRAINT "library_documentation_folder_id_library_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_documentation_pages" ADD CONSTRAINT "library_documentation_pages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_documentation_pages" ADD CONSTRAINT "library_documentation_pages_collection_id_library_documentation_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."library_documentation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_documentation_pages" ADD CONSTRAINT "library_documentation_pages_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_documentation_owner_idx" ON "library_documentation" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "library_documentation_queue_idx" ON "library_documentation" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "library_documentation_connection_uq" ON "library_documentation" USING btree ("user_id","root_url","locale") WHERE "library_documentation"."state" <> 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "library_documentation_pages_url_uq" ON "library_documentation_pages" USING btree ("collection_id","url");--> statement-breakpoint
CREATE INDEX "library_documentation_pages_queue_idx" ON "library_documentation_pages" USING btree ("collection_id","state","id");--> statement-breakpoint
CREATE INDEX "library_documentation_pages_source_idx" ON "library_documentation_pages" USING btree ("source_id");