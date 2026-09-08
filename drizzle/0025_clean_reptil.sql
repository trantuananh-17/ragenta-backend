CREATE TABLE "provider_error" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"provider" text NOT NULL,
	"model" text,
	"operation" text NOT NULL,
	"status" integer,
	"message" text NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "providerError_operation_check" CHECK ("provider_error"."operation" in ('chat', 'embedding', 'rerank', 'ingestion', 'agent', 'speech', 'vision'))
);
--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "provider_error" ADD CONSTRAINT "provider_error_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "providerError_createdAt_idx" ON "provider_error" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "providerError_provider_createdAt_idx" ON "provider_error" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX "providerError_organizationId_createdAt_idx" ON "provider_error" USING btree ("organization_id","created_at");