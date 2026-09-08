CREATE TABLE "mcp_server" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"url" text NOT NULL,
	"encrypted_secret" text,
	"secret_hint" text,
	"auth_header" text DEFAULT 'Authorization' NOT NULL,
	"auth_prefix" text DEFAULT 'Bearer ' NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_cached_at" timestamp,
	"last_checked_at" timestamp,
	"last_check_ok" boolean,
	"last_check_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcpServer_workspace_slug_uidx" ON "mcp_server" USING btree ("organization_id","slug") WHERE organization_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcpServer_platform_slug_uidx" ON "mcp_server" USING btree ("slug") WHERE organization_id is null;--> statement-breakpoint
CREATE INDEX "mcpServer_organizationId_idx" ON "mcp_server" USING btree ("organization_id");