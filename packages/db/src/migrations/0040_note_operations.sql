CREATE TABLE "note_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"arguments_hash" text NOT NULL,
	"note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_operations" ADD CONSTRAINT "note_operations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_operations" ADD CONSTRAINT "note_operations_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_operations_owner_operation_idx" ON "note_operations" USING btree ("user_id","operation_id");--> statement-breakpoint
CREATE INDEX "note_operations_note_idx" ON "note_operations" USING btree ("note_id");