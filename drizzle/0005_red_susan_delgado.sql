CREATE TABLE "platform_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "provider_credential" (
	"provider" text PRIMARY KEY NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_hint" text NOT NULL,
	"base_url" text,
	"last_checked_at" timestamp,
	"last_check_ok" boolean,
	"last_check_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "provider_model" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"tier" text NOT NULL,
	"context_window" integer,
	"input_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"output_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"embedding_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"embedding_dimensions" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "providerModel_capability_check" CHECK ("provider_model"."capability" in ('chat', 'embedding')),
	CONSTRAINT "providerModel_tier_check" CHECK ("provider_model"."tier" in ('economy', 'premium'))
);
--> statement-breakpoint
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model" ADD CONSTRAINT "provider_model_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "providerModel_provider_model_uidx" ON "provider_model" USING btree ("provider","model");