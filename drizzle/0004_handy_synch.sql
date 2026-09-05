CREATE TABLE "promo_code" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"credits" numeric(14, 4) NOT NULL,
	"bucket" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp,
	"updated_by" text,
	CONSTRAINT "promo_code_code_unique" UNIQUE("code"),
	CONSTRAINT "promoCode_bucket_check" CHECK ("promo_code"."bucket" in ('plan', 'topup')),
	CONSTRAINT "promoCode_credits_positive" CHECK ("promo_code"."credits" > 0),
	CONSTRAINT "promoCode_maxRedemptions_positive" CHECK ("promo_code"."max_redemptions" is null or "promo_code"."max_redemptions" > 0)
);
--> statement-breakpoint
CREATE TABLE "promo_redemption" (
	"id" text PRIMARY KEY NOT NULL,
	"code_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"credits" numeric(14, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemption" ADD CONSTRAINT "promo_redemption_code_id_promo_code_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."promo_code"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemption" ADD CONSTRAINT "promo_redemption_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemption" ADD CONSTRAINT "promo_redemption_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promoCode_createdAt_idx" ON "promo_code" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promoRedemption_codeId_organizationId_uidx" ON "promo_redemption" USING btree ("code_id","organization_id");--> statement-breakpoint
CREATE INDEX "promoRedemption_organizationId_idx" ON "promo_redemption" USING btree ("organization_id");