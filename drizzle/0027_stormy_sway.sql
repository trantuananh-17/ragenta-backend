CREATE TABLE "chat_widget" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"public_key" text NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"greeting" text DEFAULT '' NOT NULL,
	"accent_color" text DEFAULT '#7c3aed' NOT NULL,
	"title" text DEFAULT 'Chat' NOT NULL,
	"daily_credit_ceiling" numeric(14, 4) DEFAULT '50000' NOT NULL,
	"visitor_hourly_limit" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "chatWidget_visitorLimit_check" CHECK ("chat_widget"."visitor_hourly_limit" between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "chat_widget" ADD CONSTRAINT "chat_widget_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD CONSTRAINT "chat_widget_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_widget" ADD CONSTRAINT "chat_widget_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatWidget_publicKey_uidx" ON "chat_widget" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chatWidget_organizationId_name_uidx" ON "chat_widget" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "chatWidget_organizationId_idx" ON "chat_widget" USING btree ("organization_id");