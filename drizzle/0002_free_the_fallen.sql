CREATE TABLE "billing_preferences" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"auto_reload_enabled" boolean DEFAULT false NOT NULL,
	"auto_reload_threshold_credits" integer,
	"auto_reload_pack" text,
	"auto_reload_locked_until" timestamp,
	"last_failure_code" text,
	"last_failure_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_preferences" ADD CONSTRAINT "billing_preferences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;