CREATE TABLE "study_day_policy" (
	"user_id" text PRIMARY KEY NOT NULL,
	"time_zone" text NOT NULL,
	"rollover_minute" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_day_policy_rollover_minute_chk" CHECK ("study_day_policy"."rollover_minute" between 0 and 1439)
);
--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "study_epoch_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "study_epoch_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "last_review_epoch_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "goal_met_epoch_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "study_day" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "study_epoch_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "study_day_policy" ADD CONSTRAINT "study_day_policy_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_user_study_day_idx" ON "reviews" USING btree ("user_id","study_day");--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_study_epoch_bounds_chk" CHECK (("profile"."study_epoch_start" is null and "profile"."study_epoch_end" is null) or "profile"."study_epoch_start" < "profile"."study_epoch_end");
--> statement-breakpoint
-- These rows were written as UTC dates. The zone-aware clock does not rebucket them.
UPDATE "reviews"
SET
  "study_day" = to_char(("reviewed_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
  "study_epoch_start" = (date_trunc('day', "reviewed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
WHERE "study_day" IS NULL;
--> statement-breakpoint
UPDATE "profile" AS p
SET
  "study_epoch_start" = (label.day::date::timestamp AT TIME ZONE 'UTC'),
  "study_epoch_end" = ((label.day::date + 1)::timestamp AT TIME ZONE 'UTC'),
  "new_introduced_today" = CASE
    WHEN p."daily_counts_date" IS NOT DISTINCT FROM label.day THEN p."new_introduced_today"
    ELSE 0
  END,
  "reviews_done_today" = CASE
    WHEN p."daily_counts_date" IS NOT DISTINCT FROM label.day THEN p."reviews_done_today"
    ELSE 0
  END,
  "daily_counts_date" = CASE
    WHEN p."daily_counts_date" IS NOT DISTINCT FROM label.day THEN p."daily_counts_date"
    ELSE label.day
  END,
  "today_minutes" = CASE
    WHEN p."today_minutes_date" IS NOT DISTINCT FROM label.day THEN p."today_minutes"
    ELSE 0
  END
FROM (
  SELECT
    "user_id",
    GREATEST("daily_counts_date", "today_minutes_date") AS day
  FROM "profile"
  WHERE "daily_counts_date" IS NOT NULL OR "today_minutes_date" IS NOT NULL
) AS label
WHERE p."user_id" = label."user_id";
--> statement-breakpoint
UPDATE "profile"
SET "last_review_epoch_end" = (("last_review_date"::date + 1)::timestamp AT TIME ZONE 'UTC')
WHERE "last_review_date" IS NOT NULL;
--> statement-breakpoint
UPDATE "profile"
SET "goal_met_epoch_start" = ("daily_goal_met_date"::date::timestamp AT TIME ZONE 'UTC')
WHERE "daily_goal_met_date" IS NOT NULL;