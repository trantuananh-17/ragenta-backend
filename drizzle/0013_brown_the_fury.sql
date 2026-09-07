CREATE TABLE "integration" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"base_url" text,
	"encrypted_secret" text,
	"secret_hint" text,
	"auth_header" text,
	"auth_prefix" text DEFAULT '' NOT NULL,
	"allowed_methods" jsonb DEFAULT '["GET"]'::jsonb NOT NULL,
	"allowed_path_prefix" text DEFAULT '' NOT NULL,
	"allowed_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp,
	"last_checked_at" timestamp,
	"last_check_ok" boolean,
	"last_check_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "integration_kind_check" CHECK ("integration"."kind" in ('web_search', 'http_api', 'email'))
);
--> statement-breakpoint
ALTER TABLE "agent_version" ADD COLUMN "approve_writes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;