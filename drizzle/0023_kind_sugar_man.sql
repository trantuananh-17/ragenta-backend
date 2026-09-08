CREATE TABLE "oauth_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_label" text NOT NULL,
	"external_account_id" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"last_refreshed_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "oauthConnection_status_check" CHECK ("oauth_connection"."status" in ('active', 'expired', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "oauth_connection" ADD CONSTRAINT "oauth_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connection" ADD CONSTRAINT "oauth_connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauthConnection_workspace_provider_account_uidx" ON "oauth_connection" USING btree ("organization_id","provider","external_account_id");--> statement-breakpoint
CREATE INDEX "oauthConnection_organizationId_provider_idx" ON "oauth_connection" USING btree ("organization_id","provider");