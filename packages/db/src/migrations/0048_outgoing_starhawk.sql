CREATE TABLE "library_folders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_folders_name_check" CHECK ("library_folders"."name" = btrim("library_folders"."name") AND char_length("library_folders"."name") BETWEEN 1 AND 100),
	CONSTRAINT "library_folders_parent_check" CHECK ("library_folders"."parent_id" IS NULL OR "library_folders"."parent_id" <> "library_folders"."id")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_parent_id_library_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_folders_owner_parent_idx" ON "library_folders" USING btree ("user_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_folders_sibling_name_uq" ON "library_folders" USING btree ("user_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "library_folders_purpose_uq" ON "library_folders" USING btree ("user_id","purpose") WHERE "library_folders"."purpose" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_folder_id_library_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_owner_folder_idx" ON "sources" USING btree ("user_id","folder_id");