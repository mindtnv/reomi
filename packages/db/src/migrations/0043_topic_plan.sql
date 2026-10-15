CREATE TABLE "topic_module_prerequisites" (
	"module_id" uuid NOT NULL,
	"prerequisite_module_id" uuid NOT NULL,
	CONSTRAINT "topic_module_prerequisites_module_id_prerequisite_module_id_pk" PRIMARY KEY("module_id","prerequisite_module_id"),
	CONSTRAINT "topic_module_prereq_not_self" CHECK ("topic_module_prerequisites"."module_id" <> "topic_module_prerequisites"."prerequisite_module_id")
);
--> statement-breakpoint
CREATE TABLE "topic_module_sources" (
	"module_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_module_sources_module_id_source_id_pk" PRIMARY KEY("module_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "topic_modules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"plan_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_modules_plan_position_uq" UNIQUE("plan_id","position"),
	CONSTRAINT "topic_modules_position_chk" CHECK ("topic_modules"."position" >= 0),
	CONSTRAINT "topic_modules_title_chk" CHECK (char_length("topic_modules"."title") between 1 and 120),
	CONSTRAINT "topic_modules_outcome_chk" CHECK (char_length("topic_modules"."outcome") between 1 and 400)
);
--> statement-breakpoint
CREATE TABLE "topic_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"notebook_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_plans_notebook_uq" UNIQUE("notebook_id"),
	CONSTRAINT "topic_plans_goal_chk" CHECK (char_length("topic_plans"."goal") between 1 and 200),
	CONSTRAINT "topic_plans_level_chk" CHECK ("topic_plans"."level" is null or char_length("topic_plans"."level") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "topic_module_prerequisites" ADD CONSTRAINT "topic_module_prerequisites_module_id_topic_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."topic_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_module_prerequisites" ADD CONSTRAINT "topic_module_prerequisites_prerequisite_module_id_topic_modules_id_fk" FOREIGN KEY ("prerequisite_module_id") REFERENCES "public"."topic_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_module_sources" ADD CONSTRAINT "topic_module_sources_module_id_topic_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."topic_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_module_sources" ADD CONSTRAINT "topic_module_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_module_sources" ADD CONSTRAINT "topic_module_sources_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_modules" ADD CONSTRAINT "topic_modules_plan_id_topic_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."topic_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_modules" ADD CONSTRAINT "topic_modules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_plans" ADD CONSTRAINT "topic_plans_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_plans" ADD CONSTRAINT "topic_plans_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_module_sources_source_idx" ON "topic_module_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "topic_module_sources_user_idx" ON "topic_module_sources" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topic_modules_user_idx" ON "topic_modules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topic_plans_user_idx" ON "topic_plans" USING btree ("user_id");