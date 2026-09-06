ALTER TABLE "conversation" ADD COLUMN "grounded_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "refine_follow_ups" boolean DEFAULT true NOT NULL;