CREATE TABLE "webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp,
	CONSTRAINT "webhookDelivery_status_check" CHECK ("webhook_delivery"."status" in ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_hint" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp,
	"last_delivery_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhookDelivery_endpointId_createdAt_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhookDelivery_organizationId_createdAt_idx" ON "webhook_delivery" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "webhookEndpoint_organizationId_idx" ON "webhook_endpoint" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "webhookEndpoint_enabled_idx" ON "webhook_endpoint" USING btree ("organization_id","enabled");