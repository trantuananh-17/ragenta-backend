CREATE TABLE "payment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"description" text NOT NULL,
	"external_id" text NOT NULL,
	"hosted_invoice_url" text,
	"invoice_pdf_url" text,
	"period_start" timestamp,
	"period_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_kind_check" CHECK ("payment"."kind" in ('subscription', 'topup')),
	CONSTRAINT "payment_status_check" CHECK ("payment"."status" in ('paid', 'failed', 'refunded'))
);
--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_externalId_uidx" ON "payment" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "payment_organizationId_createdAt_idx" ON "payment" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_createdAt_idx" ON "payment" USING btree ("created_at");