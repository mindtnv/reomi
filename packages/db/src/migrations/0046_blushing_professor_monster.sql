CREATE TABLE "note_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"note_id" uuid NOT NULL,
	"note_type_id" uuid NOT NULL,
	"field_values" jsonb NOT NULL,
	"tags" text[] NOT NULL,
	"accepted_answers" text[] NOT NULL,
	"revised_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_revisions_note_revised_uq" UNIQUE("note_id","revised_at")
);
--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_revisions_note_revised_idx" ON "note_revisions" USING btree ("note_id","revised_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "note_revisions_user_created_idx" ON "note_revisions" USING btree ("user_id","created_at","id");