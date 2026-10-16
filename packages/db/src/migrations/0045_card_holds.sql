-- Rollback: DROP TABLE "card_holds";
CREATE TABLE "card_holds" (
	"card_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"buried_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_holds_reason_chk" CHECK ("card_holds"."reason" in ('user', 'sibling'))
);
--> statement-breakpoint
ALTER TABLE "card_holds" ADD CONSTRAINT "card_holds_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_holds" ADD CONSTRAINT "card_holds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_holds_user_until_idx" ON "card_holds" USING btree ("user_id","buried_until");