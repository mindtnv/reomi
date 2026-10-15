CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"study_day" text NOT NULL,
	"status" text NOT NULL,
	"lease_until" timestamp with time zone,
	"error_code" text,
	"push_service" text,
	CONSTRAINT "notification_deliveries_slot_uq" UNIQUE("user_id","kind","channel","study_day"),
	CONSTRAINT "notification_deliveries_kind_chk" CHECK ("notification_deliveries"."kind" in ('due_digest', 'streak_warning')),
	CONSTRAINT "notification_deliveries_channel_chk" CHECK ("notification_deliveries"."channel" in ('web_push', 'email')),
	CONSTRAINT "notification_deliveries_status_chk" CHECK ("notification_deliveries"."status" in ('reserved', 'sent', 'skipped', 'failed')),
	CONSTRAINT "notification_deliveries_push_service_chk" CHECK ("notification_deliveries"."push_service" is null or "notification_deliveries"."push_service" in ('fcm', 'mozilla', 'apple', 'other'))
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"digest_enabled" boolean DEFAULT false NOT NULL,
	"streak_warning_enabled" boolean DEFAULT false NOT NULL,
	"time_zone" text NOT NULL,
	"digest_hour" integer NOT NULL,
	"streak_hour" integer NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"push_enabled" boolean DEFAULT false NOT NULL,
	"locale" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_digest_hour_chk" CHECK ("notification_settings"."digest_hour" between 0 and 23),
	CONSTRAINT "notification_settings_streak_hour_chk" CHECK ("notification_settings"."streak_hour" between 0 and 23),
	CONSTRAINT "notification_settings_locale_chk" CHECK ("notification_settings"."locale" in ('ru', 'en'))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"expiration" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_user_endpoint_uq" UNIQUE("user_id","endpoint")
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;